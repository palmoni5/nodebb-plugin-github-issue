'use strict';

const winston = require.main.require('winston');

const db = require.main.require('./src/database');
const posts = require.main.require('./src/posts');
const groups = require.main.require('./src/groups');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const translator = require.main.require('./src/translator');
const routeHelpers = require.main.require('./src/routes/helpers');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const SocketAdmin = require.main.require('./src/socket.io/admin');

const plugin = {};

const CONFIG_KEY = 'plugin:github-issue:config';
const PID_KEY_PREFIX = 'plugin:github-issue:pid:';
const TID_KEY_PREFIX = 'plugin:github-issue:tid:';
const PRIVILEGE = 'plugin-github-issue';
const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_BEFORE_DAYS = 10;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

let cachedConfig = null;

async function getConfig() {
	if (!cachedConfig) {
		cachedConfig = await db.getObject(CONFIG_KEY) || {};
	}
	return cachedConfig;
}

function getExpiresAt(config) {
	const days = parseInt(config.expiryDays, 10);
	const setAt = parseInt(config.tokenSetAt, 10);
	if (!config.token || !days || days <= 0 || !setAt) {
		return 0;
	}
	return setAt + (days * DAY_MS);
}

async function buildStatus() {
	const config = await getConfig();
	const expiresAt = getExpiresAt(config);
	const now = Date.now();
	return {
		title: '[[github-issue:admin.title]]',
		repo: config.repo || '',
		labels: config.labels || '',
		expiryDays: config.expiryDays || '',
		publicSidebar: parseInt(config.publicSidebar, 10) === 1,
		tokenSet: !!config.token,
		tokenSetAt: config.tokenSetAt ? new Date(parseInt(config.tokenSetAt, 10)).toISOString().slice(0, 10) : '',
		hasExpiry: !!expiresAt,
		expiresAtDate: expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : '',
		daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)) : 0,
		expired: !!expiresAt && now >= expiresAt,
	};
}

plugin.init = async function ({ router }) {
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/github-issue', async (req, res) => {
		res.render('admin/plugins/github-issue', await buildStatus());
	});

	SocketAdmin.plugins.githubIssue = {
		getStatus: async () => buildStatus(),
		save: async (socket, data) => {
			data = data || {};
			const repo = String(data.repo || '').trim();
			if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
				throw new Error('[[github-issue:error.invalid-repo]]');
			}
			const expiryRaw = String(data.expiryDays === undefined || data.expiryDays === null ? '' : data.expiryDays).trim();
			if (expiryRaw && (!/^\d+$/.test(expiryRaw) || parseInt(expiryRaw, 10) <= 0)) {
				throw new Error('[[github-issue:error.invalid-expiry]]');
			}
			const config = await getConfig();
			const newToken = typeof data.token === 'string' ? data.token.trim() : '';
			const update = {
				repo: repo,
				labels: String(data.labels || '').trim(),
				expiryDays: expiryRaw,
				publicSidebar: data.publicSidebar ? 1 : 0,
			};
			if (newToken) {
				update.token = newToken;
				update.tokenSetAt = Date.now();
			}
			// any token/expiry change re-arms the warning notifications
			if (newToken || expiryRaw !== String(config.expiryDays || '')) {
				update.warned10 = 0;
				update.warnedExpired = 0;
			}
			await db.setObject(CONFIG_KEY, update);
			cachedConfig = null;
			checkExpiry().catch(err => winston.error(`[github-issue] expiry check failed: ${err.stack}`));
			return buildStatus();
		},
	};

	SocketPlugins.githubIssue = {
		create: async (socket, data) => {
			if (!socket.uid) {
				throw new Error('[[error:not-logged-in]]');
			}
			data = data || {};
			const pid = data.pid;
			const title = String(data.title || '').trim();
			const body = String(data.body || '');
			if (!pid || !title) {
				throw new Error('[[error:invalid-data]]');
			}
			if (title.length > 256 || body.length > 65536) {
				throw new Error('[[error:invalid-data]]');
			}
			const [allowed, canRead] = await Promise.all([
				privileges.global.can(PRIVILEGE, socket.uid),
				privileges.posts.can('topics:read', pid, socket.uid),
			]);
			if (!allowed || !canRead) {
				throw new Error('[[error:no-privileges]]');
			}
			const config = await getConfig();
			if (!config.token || !config.repo) {
				throw new Error('[[github-issue:error.not-configured]]');
			}
			const expiresAt = getExpiresAt(config);
			if (expiresAt && Date.now() >= expiresAt) {
				throw new Error('[[github-issue:error.token-expired]]');
			}
			const labels = String(config.labels || '')
				.split(',')
				.map(l => l.trim())
				.filter(Boolean);
			const payload = { title: title, body: body };
			if (labels.length) {
				// GitHub silently drops `labels` when the token lacks push/triage
				// access, so also embed a marker the repo can act on via a
				// workflow (see README) to apply the labels with its own token.
				payload.labels = labels;
				payload.body += `\n\n<!-- forum-labels: ${labels.join(', ')} -->`;
			}
			let response;
			try {
				response = await fetch(`https://api.github.com/repos/${config.repo}/issues`, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${config.token}`,
						Accept: 'application/vnd.github+json',
						'Content-Type': 'application/json',
						'User-Agent': 'nodebb-plugin-github-issue',
						'X-GitHub-Api-Version': '2022-11-28',
					},
					body: JSON.stringify(payload),
				});
			} catch (err) {
				winston.error(`[github-issue] request failed: ${err.stack}`);
				throw new Error('[[github-issue:error.request-failed]]');
			}
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				winston.error(`[github-issue] GitHub API ${response.status}: ${text.slice(0, 500)}`);
				throw new Error(`[[github-issue:error.github, ${response.status}]]`);
			}
			const issue = await response.json();
			const tid = parseInt(await posts.getPostField(pid, 'tid'), 10) || 0;
			const timestamp = Date.now();
			await db.setObject(PID_KEY_PREFIX + pid, {
				url: issue.html_url,
				number: issue.number,
				title: issue.title || title,
				timestamp: timestamp,
				uid: socket.uid,
				tid: tid,
				state: 'open',
				stateReason: '',
				stateCheckedAt: timestamp,
			});
			if (tid) {
				await db.sortedSetAdd(TID_KEY_PREFIX + tid, timestamp, pid);
			}
			return {
				url: issue.html_url,
				number: issue.number,
				title: issue.title || title,
				pid: parseInt(pid, 10),
				timestamp: timestamp,
				state: 'open',
				stateReason: '',
			};
		},
		findDuplicates: async (socket, data) => {
			if (!socket.uid) {
				throw new Error('[[error:not-logged-in]]');
			}
			const title = String((data && data.title) || '').trim();
			if (!title || title.length > 256) {
				throw new Error('[[error:invalid-data]]');
			}
			const allowed = await privileges.global.can(PRIVILEGE, socket.uid);
			if (!allowed) {
				throw new Error('[[error:no-privileges]]');
			}
			const config = await getConfig();
			if (!config.token || !config.repo) {
				return [];
			}
			return await findIssuesByTitle(config, title);
		},
		getExisting: async (socket, data) => {
			if (!socket.uid) {
				throw new Error('[[error:not-logged-in]]');
			}
			const pid = data && data.pid;
			if (!pid) {
				throw new Error('[[error:invalid-data]]');
			}
			const [allowed, canRead] = await Promise.all([
				privileges.global.can(PRIVILEGE, socket.uid),
				privileges.posts.can('topics:read', pid, socket.uid),
			]);
			if (!allowed || !canRead) {
				throw new Error('[[error:no-privileges]]');
			}
			const existing = await db.getObject(PID_KEY_PREFIX + pid);
			if (!existing || !existing.url) {
				return null;
			}
			return { url: existing.url, number: parseInt(existing.number, 10) || 0 };
		},
	};

	backfillTopicIndex().catch(err => winston.error(`[github-issue] topic index backfill failed: ${err.stack}`));

	setInterval(() => {
		checkExpiry().catch(err => winston.error(`[github-issue] expiry check failed: ${err.stack}`));
	}, CHECK_INTERVAL_MS);
	setTimeout(() => {
		checkExpiry().catch(err => winston.error(`[github-issue] expiry check failed: ${err.stack}`));
	}, 30 * 1000);
};

plugin.addPrivilege = async function (data) {
	data.privileges.set(PRIVILEGE, {
		label: '[[github-issue:privilege-label]]',
		type: 'other',
	});
};

plugin.addPostTool = async function (data) {
	if (!data.uid) {
		return data;
	}
	const config = await getConfig();
	if (!config.token || !config.repo) {
		return data;
	}
	const allowed = await privileges.global.can(PRIVILEGE, data.uid);
	if (allowed) {
		data.tools.push({
			action: 'post/github-issue',
			html: '[[github-issue:open-issue]]',
			icon: 'fa-github',
		});
	}
	return data;
};

plugin.addAdminNavigation = async function (header) {
	header.plugins.push({
		route: '/plugins/github-issue',
		icon: 'fa-github',
		name: '[[github-issue:admin.title]]',
	});
	return header;
};

async function getTopicIssues(tid) {
	if (!tid) {
		return [];
	}
	const pids = await db.getSortedSetRange(TID_KEY_PREFIX + tid, 0, -1);
	if (!pids.length) {
		return [];
	}
	const issues = await db.getObjects(pids.map(pid => PID_KEY_PREFIX + pid));
	const list = issues.map((issue, i) => {
		if (!issue || !issue.url) {
			return null;
		}
		return {
			pid: parseInt(pids[i], 10),
			url: issue.url,
			number: parseInt(issue.number, 10) || 0,
			title: issue.title || '',
			timestamp: parseInt(issue.timestamp, 10) || 0,
			state: issue.state || '',
			stateReason: issue.stateReason || '',
			stateCheckedAt: parseInt(issue.stateCheckedAt, 10) || 0,
		};
	}).filter(Boolean);
	await refreshIssueStates(list);
	list.forEach((issue) => { delete issue.stateCheckedAt; });
	return list;
}

function normalizeTitle(title) {
	return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// GitHub's search API has no exact-title operator, so ask for an `in:title`
// phrase match and keep only the hits whose title is actually identical.
// A failed/rate-limited search returns an empty list on purpose: the duplicate
// check is advisory and must never block issue creation.
async function findIssuesByTitle(config, title) {
	// quotes and backslashes would break out of the quoted search phrase
	const phrase = title.replace(/["\\]/g, ' ').trim();
	if (!phrase) {
		return [];
	}
	const query = `repo:${config.repo} is:issue in:title "${phrase}"`;
	let response;
	try {
		response = await fetch(`https://api.github.com/search/issues?per_page=20&q=${encodeURIComponent(query)}`, {
			headers: {
				Authorization: `Bearer ${config.token}`,
				Accept: 'application/vnd.github+json',
				'User-Agent': 'nodebb-plugin-github-issue',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		});
	} catch (err) {
		winston.warn(`[github-issue] duplicate search failed: ${err.message}`);
		return [];
	}
	if (!response.ok) {
		winston.warn(`[github-issue] duplicate search returned ${response.status}`);
		return [];
	}
	const body = await response.json().catch(() => null);
	const items = (body && Array.isArray(body.items)) ? body.items : [];
	const wanted = normalizeTitle(title);
	return items
		.filter(item => item && !item.pull_request && normalizeTitle(item.title) === wanted)
		.map(item => ({
			number: item.number,
			url: item.html_url,
			title: item.title,
			state: item.state || '',
			stateReason: item.state_reason || '',
		}));
}

// the repo an issue lives in is derived from its stored URL rather than the
// current config, so states stay correct after the target repo changes
function apiUrlFromIssueUrl(url) {
	const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(String(url || ''));
	return match ? `https://api.github.com/repos/${match[1]}/issues/${match[2]}` : '';
}

async function refreshIssueStates(list) {
	const config = await getConfig();
	if (!config.token) {
		return;
	}
	const now = Date.now();
	const stale = list.filter(issue => now - issue.stateCheckedAt >= STATE_TTL_MS && apiUrlFromIssueUrl(issue.url));
	if (!stale.length) {
		return;
	}
	await Promise.all(stale.map(async (issue) => {
		let fetched = null;
		try {
			const response = await fetch(apiUrlFromIssueUrl(issue.url), {
				headers: {
					Authorization: `Bearer ${config.token}`,
					Accept: 'application/vnd.github+json',
					'User-Agent': 'nodebb-plugin-github-issue',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});
			if (response.ok) {
				fetched = await response.json();
			} else {
				winston.warn(`[github-issue] state check for #${issue.number} returned ${response.status}`);
			}
		} catch (err) {
			winston.warn(`[github-issue] state check for #${issue.number} failed: ${err.message}`);
		}
		if (fetched && fetched.state) {
			issue.state = fetched.state;
			issue.stateReason = fetched.state_reason || '';
			if (fetched.title) {
				issue.title = fetched.title;
			}
		}
		// stamp even on failure so a broken token doesn't delay page loads
		// with a GitHub round-trip on every visit
		await db.setObject(PID_KEY_PREFIX + issue.pid, {
			state: issue.state,
			stateReason: issue.stateReason,
			title: issue.title,
			stateCheckedAt: now,
		});
	}));
}

plugin.addTopicIssues = async function (data) {
	const templateData = data && data.templateData;
	const uid = (data.req && data.req.uid) || 0;
	if (!templateData || !templateData.tid || !uid) {
		return data;
	}
	const config = await getConfig();
	const isPublic = parseInt(config.publicSidebar, 10) === 1;
	const allowed = isPublic || await privileges.global.can(PRIVILEGE, uid);
	if (!allowed) {
		return data;
	}
	templateData.githubIssues = await getTopicIssues(templateData.tid);
	return data;
};

// issues opened before the per-topic index existed are only keyed by pid
async function backfillTopicIndex() {
	const config = await getConfig();
	if (parseInt(config.tidIndexBuilt, 10)) {
		return;
	}
	const keys = await db.scan({ match: `${PID_KEY_PREFIX}*` });
	let indexed = 0;
	for (const key of keys) {
		const issue = await db.getObject(key);
		if (!issue || !issue.url || parseInt(issue.tid, 10)) {
			continue;
		}
		const pid = key.slice(PID_KEY_PREFIX.length);
		const tid = parseInt(await posts.getPostField(pid, 'tid'), 10) || 0;
		if (!tid) {
			continue;
		}
		await Promise.all([
			db.setObjectField(key, 'tid', tid),
			db.sortedSetAdd(TID_KEY_PREFIX + tid, parseInt(issue.timestamp, 10) || Date.now(), pid),
		]);
		indexed += 1;
	}
	await db.setObjectField(CONFIG_KEY, 'tidIndexBuilt', 1);
	cachedConfig = null;
	if (indexed) {
		winston.info(`[github-issue] indexed ${indexed} existing issue(s) by topic`);
	}
}

async function checkExpiry() {
	const config = await getConfig();
	const expiresAt = getExpiresAt(config);
	if (!expiresAt) {
		return;
	}
	const now = Date.now();
	if (now >= expiresAt && !parseInt(config.warnedExpired, 10)) {
		await notifyAdmins('expired', 0, config);
		await db.setObjectField(CONFIG_KEY, 'warnedExpired', 1);
		cachedConfig = null;
	} else if (now < expiresAt && now >= expiresAt - (WARN_BEFORE_DAYS * DAY_MS) && !parseInt(config.warned10, 10)) {
		const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
		await notifyAdmins('expiring', daysLeft, config);
		await db.setObjectField(CONFIG_KEY, 'warned10', 1);
		cachedConfig = null;
	}
}

async function notifyAdmins(type, daysLeft, config) {
	const uids = await groups.getMembers('administrators', 0, -1);
	if (!uids.length) {
		return;
	}
	const bodyShort = type === 'expired' ?
		translator.compile('github-issue:notify.expired') :
		translator.compile('github-issue:notify.expiring', daysLeft);
	const notification = await notifications.create({
		type: 'github-issue-token',
		bodyShort: bodyShort,
		nid: `github-issue:token:${type}:${config.tokenSetAt}`,
		path: '/admin/plugins/github-issue',
	});
	await notifications.push(notification, uids);
	winston.info(`[github-issue] notified ${uids.length} admin(s): token ${type}`);
}

module.exports = plugin;
