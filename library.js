'use strict';

const winston = require.main.require('winston');

const db = require.main.require('./src/database');
const groups = require.main.require('./src/groups');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const translator = require.main.require('./src/translator');
const routeHelpers = require.main.require('./src/routes/helpers');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const SocketAdmin = require.main.require('./src/socket.io/admin');

const plugin = {};

const CONFIG_KEY = 'plugin:github-issue:config';
const PRIVILEGE = 'plugin-github-issue';
const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_BEFORE_DAYS = 10;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
				payload.labels = labels;
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
			return { url: issue.html_url, number: issue.number };
		},
	};

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
