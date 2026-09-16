'use strict';

const db = require.main.require('./src/database');
const posts = require.main.require('./src/posts');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const translator = require.main.require('./src/translator');
const websockets = require.main.require('./src/socket.io');

const common = require('./common');

const notify = module.exports;

const TITLE_MAX = 80;
const NOTIFIED_KEY = 'plugin:github-issue:notified';
const NOTIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function shorten(text) {
	text = String(text || '').trim();
	return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

notify.shorten = shorten;

// whoever pressed the button already watches the issue on GitHub; the person
// who needs to be told what happened to it is the author of the post
async function getRecipients(pid) {
	const uid = parseInt(await posts.getPostField(pid, 'uid'), 10) || 0;
	if (!uid) {
		return [];
	}
	const canRead = await privileges.posts.can('topics:read', pid, uid);
	return canRead ? [uid] : [];
}

/**
 * Sends one notification about a GitHub issue to the users tracking it.
 * `dedupe` must be derived from the GitHub payload (a comment id, a timestamp)
 * rather than from the delivery, so that the webhook and the poller produce the
 * same nid for the same event and no user is notified twice.
 */
notify.issueEvent = async function ({ pid, event, dedupe, bodyShort, url, tid }) {
	const config = await common.getConfig();
	if (!common.isNotifyEnabled(config, event)) {
		return;
	}
	const stored = await db.getObject(common.PID_KEY_PREFIX + pid);
	if (!stored || !stored.url) {
		return;
	}
	const uids = await getRecipients(pid);
	if (!uids.length) {
		return;
	}
	const repo = common.repoFromIssueUrl(stored.url) || 'github';
	const nid = `github-issue:${repo}#${stored.number}:${event}:${dedupe}`;
	// re-creating a notification under an existing nid does not suppress it, it
	// puts it back at the top of the unread list — and both channels replay
	// events (GitHub's `since` is inclusive, webhook deliveries are retried), so
	// what has already been sent is tracked explicitly
	if (await db.isSortedSetMember(NOTIFIED_KEY, nid)) {
		return;
	}
	await db.sortedSetAdd(NOTIFIED_KEY, Date.now(), nid);
	const notification = await notifications.create({
		type: `github-issue-${event}`,
		bodyShort: bodyShort,
		nid: nid,
		path: url || stored.url,
		icon: 'fa-github',
		pid: parseInt(pid, 10),
		tid: parseInt(tid || stored.tid, 10) || undefined,
	});
	if (notification) {
		await notifications.push(notification, uids);
	}
};

notify.pruneSent = async function () {
	await db.sortedSetsRemoveRangeByScore([NOTIFIED_KEY], '-inf', Date.now() - NOTIFIED_TTL_MS);
};

/**
 * Persists a fresh snapshot of an issue and pushes it to everyone currently
 * viewing the topic, so an open topic reflects a GitHub change immediately.
 */
notify.applyIssueUpdate = async function (pid, fields) {
	const update = { ...fields, stateCheckedAt: Date.now() };
	await db.setObject(common.PID_KEY_PREFIX + pid, update);
	const stored = await db.getObject(common.PID_KEY_PREFIX + pid);
	const tid = parseInt(stored && stored.tid, 10) || 0;
	if (!tid) {
		return;
	}
	websockets.in(`topic_${tid}`).emit('event:github-issue.updated', {
		tid: tid,
		issue: {
			pid: parseInt(pid, 10),
			url: stored.url,
			number: parseInt(stored.number, 10) || 0,
			title: stored.title || '',
			timestamp: parseInt(stored.timestamp, 10) || 0,
			state: stored.state || '',
			stateReason: stored.stateReason || '',
		},
	});
};

// Builders for the events both the webhook and the poller can detect. They are
// shared so that the two paths produce identical `event`/`dedupe` pairs.
notify.build = {
	closed: issue => ({
		event: 'closed',
		dedupe: `closed:${issue.closed_at || issue.updated_at || ''}`,
		bodyShort: translator.compile(
			`github-issue:notify.closed-${issue.state_reason === 'not_planned' ? 'not-planned' : (issue.state_reason === 'duplicate' ? 'duplicate' : 'completed')}`,
			issue.number,
			shorten(issue.title)
		),
	}),
	reopened: issue => ({
		event: 'reopened',
		dedupe: `reopened:${issue.updated_at || ''}`,
		bodyShort: translator.compile('github-issue:notify.reopened', issue.number, shorten(issue.title)),
	}),
	renamed: issue => ({
		event: 'renamed',
		dedupe: `renamed:${issue.updated_at || ''}`,
		bodyShort: translator.compile('github-issue:notify.renamed', issue.number, shorten(issue.title)),
	}),
	comment: (issue, comment) => ({
		event: 'comment',
		dedupe: `comment:${comment.id}`,
		url: comment.html_url,
		bodyShort: translator.compile(
			'github-issue:notify.comment',
			(comment.user && comment.user.login) || '?',
			issue.number,
			shorten(issue.title)
		),
	}),
};

/**
 * Diffs a freshly fetched issue against the stored snapshot, notifies about
 * what changed and stores the new snapshot. Used by every path that learns an
 * issue's current state without an event stream (the poller and the lazy
 * refresh on topic load), so a change is announced exactly once no matter which
 * one observes it first.
 */
notify.applySnapshot = async function (pid, stored, issue) {
	const state = issue.state || '';
	const stateReason = issue.state_reason || '';
	const title = issue.title || '';
	const events = [];
	if ((stored.state || '') !== state) {
		events.push(state === 'closed' ? notify.build.closed(issue) : notify.build.reopened(issue));
	} else if (state === 'closed' && (stored.stateReason || '') !== stateReason) {
		events.push(notify.build.closed(issue));
	}
	if (stored.title && stored.title !== title) {
		events.push(notify.build.renamed(issue));
	}
	if (!events.length) {
		return false;
	}
	await notify.applyIssueUpdate(pid, { state: state, stateReason: stateReason, title: title });
	for (const event of events) {
		await notify.issueEvent({ pid: pid, ...event });
	}
	return true;
};
