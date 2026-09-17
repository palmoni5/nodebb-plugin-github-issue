'use strict';

const nconf = require.main.require('nconf');
const db = require.main.require('./src/database');

const common = require('./common');
const notify = require('./notify');
const issues = require('./issues');

const poll = module.exports;

const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_INTERVAL_MINUTES = 5;
const MAX_PAGES = 5;
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;

let timer = null;
let running = false;

poll.getIntervalMinutes = function (config) {
	const minutes = parseInt(config.pollMinutes, 10);
	return Math.max(MIN_INTERVAL_MINUTES, minutes || DEFAULT_INTERVAL_MINUTES);
};

poll.isEnabled = function (config) {
	return parseInt(config.pollEnabled, 10) === 1;
};

// only the primary process runs jobs, otherwise every worker in a cluster would
// poll GitHub and race to push the same notifications
poll.reschedule = async function () {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	if (!nconf.get('runJobs')) {
		return;
	}
	const config = await common.getConfig();
	if (!poll.isEnabled(config)) {
		return;
	}
	timer = setInterval(() => {
		poll.run().catch(err => common.logError('poll failed', err));
	}, poll.getIntervalMinutes(config) * 60 * 1000);
};

poll.run = async function () {
	if (running) {
		return;
	}
	const config = await common.getConfig();
	const expiresAt = common.getExpiresAt(config);
	if (!poll.isEnabled(config) || !config.token || !config.repo) {
		return;
	}
	if (expiresAt && Date.now() >= expiresAt) {
		return;
	}
	running = true;
	try {
		await pollIssues(config);
		await pollComments(config);
	} finally {
		running = false;
	}
};

function parseNextLink(header) {
	const match = /<([^>]+)>;\s*rel="next"/.exec(String(header || ''));
	return match ? match[1] : '';
}

async function fetchPages(firstUrl, etag, config) {
	const pages = [];
	let url = firstUrl;
	let newEtag = etag;
	for (let page = 0; page < MAX_PAGES && url; page += 1) {
		const headers = (page === 0 && etag) ? { 'If-None-Match': etag } : {};
		const response = await common.ghFetch(url, { headers: headers, config: config });
		if (response.status === 304) {
			return { notModified: true, pages: [], etag: etag };
		}
		if (!response.ok) {
			common.logWarn(`poll request to ${url} returned ${response.status}`);
			return { notModified: false, pages: pages, etag: newEtag };
		}
		if (page === 0) {
			newEtag = response.headers.get('etag') || '';
		}
		const body = await response.json().catch(() => null);
		if (!Array.isArray(body)) {
			break;
		}
		pages.push(...body);
		url = parseNextLink(response.headers.get('link'));
	}
	return { notModified: false, pages: pages, etag: newEtag };
}

function sinceOrDefault(value) {
	return value || new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();
}

function maxTimestamp(current, candidate) {
	if (!candidate) {
		return current;
	}
	return !current || new Date(candidate) > new Date(current) ? candidate : current;
}

async function saveCursor(fields) {
	await db.setObject(common.CONFIG_KEY, fields);
	common.clearConfigCache();
}

async function pollIssues(config) {
	const since = sinceOrDefault(config.pollIssuesSince);
	const url = `https://api.github.com/repos/${config.repo}/issues` +
		`?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`;
	const result = await fetchPages(url, config.pollIssuesEtag, config);
	if (result.notModified) {
		return;
	}
	let cursor = since;
	for (const ghIssue of result.pages) {
		if (!ghIssue || ghIssue.pull_request) {
			continue;
		}
		cursor = maxTimestamp(cursor, ghIssue.updated_at);
		const stored = await issues.getByNumber(config.repo, ghIssue.number);
		if (stored) {
			// the poller has no event stream, so changes are derived by diffing
			// the issue against the snapshot stored when it was last seen
			await notify.applySnapshot(stored, ghIssue);
		}
	}
	await saveCursor({ pollIssuesSince: cursor, pollIssuesEtag: result.etag || '' });
}

async function pollComments(config) {
	const since = sinceOrDefault(config.pollCommentsSince);
	const url = `https://api.github.com/repos/${config.repo}/issues/comments` +
		`?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`;
	const result = await fetchPages(url, config.pollCommentsEtag, config);
	if (result.notModified) {
		return;
	}
	let cursor = since;
	for (const comment of result.pages) {
		if (!comment || !comment.issue_url) {
			continue;
		}
		cursor = maxTimestamp(cursor, comment.updated_at);
		await handleComment(config, comment);
	}
	await saveCursor({ pollCommentsSince: cursor, pollCommentsEtag: result.etag || '' });
}

async function handleComment(config, comment) {
	const match = /\/issues\/(\d+)$/.exec(comment.issue_url);
	if (!match) {
		return;
	}
	const number = parseInt(match[1], 10);
	const stored = await issues.getByNumber(config.repo, number);
	if (!stored) {
		return;
	}
	const built = notify.build.comment({ number: number, title: stored.title }, comment);
	await notify.issueEvent({ issue: stored, ...built });
}
