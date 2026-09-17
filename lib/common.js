'use strict';

const winston = require.main.require('winston');
const db = require.main.require('./src/database');

const common = module.exports;

common.CONFIG_KEY = 'plugin:github-issue:config';
common.PID_KEY_PREFIX = 'plugin:github-issue:pid:';
common.TID_KEY_PREFIX = 'plugin:github-issue:tid:';
common.INDEX_KEY = 'plugin:github-issue:index';
common.PRIVILEGE = 'plugin-github-issue';
common.DAY_MS = 24 * 60 * 60 * 1000;

// every event the plugin can notify about; the admin page renders one switch
// per entry and stores the enabled ones as a comma separated list
common.NOTIFY_EVENTS = [
	'closed', 'reopened', 'comment', 'renamed',
	'labeled', 'assigned', 'milestone',
];
const DEFAULT_NOTIFY_EVENTS = ['closed', 'reopened', 'comment', 'renamed'];

let cachedConfig = null;

common.getConfig = async function () {
	if (!cachedConfig) {
		cachedConfig = await db.getObject(common.CONFIG_KEY) || {};
	}
	return cachedConfig;
};

common.clearConfigCache = function () {
	cachedConfig = null;
};

common.getExpiresAt = function (config) {
	const days = parseInt(config.expiryDays, 10);
	const setAt = parseInt(config.tokenSetAt, 10);
	if (!config.token || !days || days <= 0 || !setAt) {
		return 0;
	}
	return setAt + (days * common.DAY_MS);
};

common.getNotifyEvents = function (config) {
	if (config.notifyEvents === undefined || config.notifyEvents === null) {
		return DEFAULT_NOTIFY_EVENTS.slice();
	}
	return String(config.notifyEvents)
		.split(',')
		.map(event => event.trim())
		.filter(event => common.NOTIFY_EVENTS.includes(event));
};

common.isNotifyEnabled = function (config, event) {
	return common.getNotifyEvents(config).includes(event);
};

// the repo an issue lives in is derived from its stored URL rather than the
// current config, so states stay correct after the target repo changes
common.apiUrlFromIssueUrl = function (url) {
	const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(String(url || ''));
	return match ? `https://api.github.com/repos/${match[1]}/issues/${match[2]}` : '';
};

common.repoFromIssueUrl = function (url) {
	const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+$/.exec(String(url || ''));
	return match ? match[1] : '';
};

common.indexField = function (repo, number) {
	return `${String(repo).toLowerCase()}#${parseInt(number, 10) || 0}`;
};

common.indexIssue = async function (repo, number, pid) {
	if (!repo || !number || !pid) {
		return;
	}
	await db.setObjectField(common.INDEX_KEY, common.indexField(repo, number), parseInt(pid, 10));
};

common.getPidForIssue = async function (repo, number) {
	const pid = await db.getObjectField(common.INDEX_KEY, common.indexField(repo, number));
	return parseInt(pid, 10) || 0;
};

common.ghFetch = async function (url, options) {
	options = options || {};
	const config = options.config || await common.getConfig();
	const headers = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'nodebb-plugin-github-issue',
		'X-GitHub-Api-Version': '2022-11-28',
		...(options.headers || {}),
	};
	if (config.token) {
		headers.Authorization = `Bearer ${config.token}`;
	}
	return fetch(url, { ...options, headers: headers });
};

common.logError = function (context, err) {
	winston.error(`[github-issue] ${context}: ${err && err.stack ? err.stack : err}`);
};

common.logWarn = function (message) {
	winston.warn(`[github-issue] ${message}`);
};

common.ISSUE_KEY_PREFIX = 'plugin:github-issue:issue:';
common.PID_LIST_SUFFIX = ':issues';

common.issueKey = function (repo, number) {
	return common.ISSUE_KEY_PREFIX + common.indexField(repo, number);
};

common.pidListKey = function (pid) {
	return common.PID_KEY_PREFIX + pid + common.PID_LIST_SUFFIX;
};

common.getAutoLabels = function (config) {
	return String(config.labels || '')
		.split(',')
		.map(label => label.trim())
		.filter(Boolean);
};

common.isAutoLabel = function (config, label) {
	const wanted = String(label || '').trim().toLowerCase();
	return !!wanted && common.getAutoLabels(config).some(l => l.toLowerCase() === wanted);
};
