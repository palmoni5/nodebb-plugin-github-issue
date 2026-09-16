'use strict';

const winston = require.main.require('winston');
const nconf = require.main.require('nconf');

const db = require.main.require('./src/database');
const posts = require.main.require('./src/posts');
const groups = require.main.require('./src/groups');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const translator = require.main.require('./src/translator');
const routeHelpers = require.main.require('./src/routes/helpers');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const SocketAdmin = require.main.require('./src/socket.io/admin');
const websockets = require.main.require('./src/socket.io');
const pubsub = require.main.require('./src/pubsub');

const common = require('./lib/common');
const notify = require('./lib/notify');
const webhook = require('./lib/webhook');
const poll = require('./lib/poll');

const plugin = {};

const {
	CONFIG_KEY, PID_KEY_PREFIX, TID_KEY_PREFIX, PRIVILEGE, DAY_MS,
	getConfig, getExpiresAt, clearConfigCache, apiUrlFromIssueUrl,
} = common;
const WARN_BEFORE_DAYS = 10;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

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
		webhookUrl: nconf.get('url') + webhook.ROUTE,
		webhookSecretSet: !!config.webhookSecret,
		notifyEvents: common.NOTIFY_EVENTS.map(event => ({
			name: event,
			enabled: common.isNotifyEnabled(config, event),
		})),
		pollEnabled: poll.isEnabled(config),
		pollMinutes: poll.getIntervalMinutes(config),
	};
}

const CONFIG_CHANGED = 'github-issue:config-changed';

function applyConfigChange() {
	clearConfigCache();
	poll.reschedule().catch(err => common.logError('poll rescheduling failed', err));
}

pubsub.on(CONFIG_CHANGED, applyConfigChange);

plugin.init = async function ({ router }) {
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/github-issue', async (req, res) => {
		res.render('admin/plugins/github-issue', await buildStatus());
	});

	// no CSRF middleware: NodeBB applies it per route, and GitHub authenticates
	// the delivery with an HMAC over the raw body instead
	router.post(webhook.ROUTE, (req, res) => {
		webhook.handler(req, res).catch((err) => {
			common.logError('webhook failed', err);
			res.sendStatus(500);
		});
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
			const pollMinutesRaw = String(data.pollMinutes === undefined || data.pollMinutes === null ? '' : data.pollMinutes).trim();
			if (pollMinutesRaw && (!/^\d+$/.test(pollMinutesRaw) || parseInt(pollMinutesRaw, 10) <= 0)) {
				throw new Error('[[github-issue:error.invalid-interval]]');
			}
			const requestedEvents = Array.isArray(data.notifyEvents) ? data.notifyEvents : [];
			const update = {
				repo: repo,
				labels: String(data.labels || '').trim(),
				expiryDays: expiryRaw,
				publicSidebar: data.publicSidebar ? 1 : 0,
				notifyEvents: common.NOTIFY_EVENTS.filter(event => requestedEvents.includes(event)).join(','),
				pollEnabled: data.pollEnabled ? 1 : 0,
				pollMinutes: pollMinutesRaw,
			};
			if (newToken) {
				update.token = newToken;
				update.tokenSetAt = Date.now();
			}
			const newSecret = typeof data.webhookSecret === 'string' ? data.webhookSecret.trim() : '';
			if (newSecret) {
				update.webhookSecret = newSecret;
			} else if (data.clearWebhookSecret) {
				update.webhookSecret = '';
			}
			// a new repository has its own issue numbers and its own history:
			// start polling it from now rather than from the old cursor
			if (repo !== String(config.repo || '')) {
				update.pollIssuesSince = '';
				update.pollIssuesEtag = '';
				update.pollCommentsSince = '';
				update.pollCommentsEtag = '';
			}
			// any token/expiry change re-arms the warning notifications
			if (newToken || expiryRaw !== String(config.expiryDays || '')) {
				update.warned10 = 0;
				update.warnedExpired = 0;
			}
			await db.setObject(CONFIG_KEY, update);
			// every process caches the config, and only the primary runs the
			// poller, so the change has to reach all of them
			pubsub.publish(CONFIG_CHANGED);
			applyConfigChange();
			checkExpiry().catch(err => common.logError('expiry check failed', err));
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
			await common.indexIssue(config.repo, issue.number, pid);
			const result = {
				url: issue.html_url,
				number: issue.number,
				title: issue.title || title,
				pid: parseInt(pid, 10),
				timestamp: timestamp,
				state: 'open',
				stateReason: '',
			};
			if (tid) {
				websockets.in(`topic_${tid}`).emit('event:github-issue.created', { tid: tid, issue: result });
			}
			return result;
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

	// jobs only run on the primary process, otherwise every worker in a cluster
	// would duplicate the notifications
	if (!nconf.get('runJobs')) {
		return;
	}

	backfillIndexes().catch(err => common.logError('index backfill failed', err));
	poll.reschedule().catch(err => common.logError('poll scheduling failed', err));

	setInterval(() => {
		checkExpiry().catch(err => common.logError('expiry check failed', err));
		notify.pruneSent().catch(err => common.logError('pruning sent notifications failed', err));
	}, CHECK_INTERVAL_MS);
	setTimeout(() => {
		checkExpiry().catch(err => common.logError('expiry check failed', err));
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
			const response = await common.ghFetch(apiUrlFromIssueUrl(issue.url), { config: config });
			if (response.ok) {
				fetched = await response.json();
			} else {
				common.logWarn(`state check for #${issue.number} returned ${response.status}`);
			}
		} catch (err) {
			common.logWarn(`state check for #${issue.number} failed: ${err.message}`);
		}
		if (!fetched || !fetched.state) {
			// stamp even on failure so a broken token doesn't delay page loads
			// with a GitHub round-trip on every visit
			await db.setObjectField(PID_KEY_PREFIX + issue.pid, 'stateCheckedAt', now);
			return;
		}
		// go through the shared snapshot handler rather than writing the new
		// state directly: otherwise a change first observed on a page load
		// would be silently absorbed and never notified about
		await notify.applySnapshot(issue.pid, issue, fetched);
		issue.state = fetched.state;
		issue.stateReason = fetched.state_reason || '';
		issue.title = fetched.title || issue.title;
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

// issues opened before these indexes existed are only keyed by pid: the topic
// index powers the sidebar, the issue-number index maps an incoming GitHub
// event back to the post it came from
async function backfillIndexes() {
	const config = await getConfig();
	const needTopics = !parseInt(config.tidIndexBuilt, 10);
	const needNumbers = !parseInt(config.numberIndexBuilt, 10);
	if (!needTopics && !needNumbers) {
		return;
	}
	const keys = await db.scan({ match: `${PID_KEY_PREFIX}*` });
	let topics = 0;
	let numbers = 0;
	for (const key of keys) {
		const issue = await db.getObject(key);
		if (!issue || !issue.url) {
			continue;
		}
		const pid = key.slice(PID_KEY_PREFIX.length);
		if (needTopics && !parseInt(issue.tid, 10)) {
			const tid = parseInt(await posts.getPostField(pid, 'tid'), 10) || 0;
			if (tid) {
				await Promise.all([
					db.setObjectField(key, 'tid', tid),
					db.sortedSetAdd(TID_KEY_PREFIX + tid, parseInt(issue.timestamp, 10) || Date.now(), pid),
				]);
				topics += 1;
			}
		}
		const repo = common.repoFromIssueUrl(issue.url);
		if (needNumbers && repo && issue.number) {
			await common.indexIssue(repo, issue.number, pid);
			numbers += 1;
		}
	}
	await db.setObject(CONFIG_KEY, { tidIndexBuilt: 1, numberIndexBuilt: 1 });
	clearConfigCache();
	if (topics || numbers) {
		winston.info(`[github-issue] indexed ${topics} issue(s) by topic and ${numbers} by issue number`);
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
		clearConfigCache();
	} else if (now < expiresAt && now >= expiresAt - (WARN_BEFORE_DAYS * DAY_MS) && !parseInt(config.warned10, 10)) {
		const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
		await notifyAdmins('expiring', daysLeft, config);
		await db.setObjectField(CONFIG_KEY, 'warned10', 1);
		clearConfigCache();
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
