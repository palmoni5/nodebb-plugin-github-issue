'use strict';

const db = require.main.require('./src/database');
const posts = require.main.require('./src/posts');
const privileges = require.main.require('./src/privileges');
const notifications = require.main.require('./src/notifications');
const translator = require.main.require('./src/translator');
const websockets = require.main.require('./src/socket.io');

const common = require('./common');
const issues = require('./issues');

const notify = module.exports;

const TITLE_MAX = 80;
const NOTIFIED_KEY = 'plugin:github-issue:notified';
const NOTIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MERGE_SECONDS = 60;
const MERGE_PREFIX = 'github-issue';

// when several events for one issue are merged, the notification speaks with
// the voice of the most significant of them
const EVENT_PRIORITY = ['opened', 'closed', 'reopened', 'renamed', 'comment', 'assigned', 'milestone', 'labeled'];

function shorten(text) {
	text = String(text || '').trim();
	return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

notify.shorten = shorten;

notify.getMergeSeconds = function (config) {
	if (config.mergeSeconds === undefined || config.mergeSeconds === null || config.mergeSeconds === '') {
		return DEFAULT_MERGE_SECONDS;
	}
	return Math.max(0, parseInt(config.mergeSeconds, 10) || 0);
};

// whoever pressed the button already watches the issue on GitHub; the person
// who needs to be told what happened to it is the author of the post
async function getRecipients(pid, skipUid) {
	const uid = parseInt(await posts.getPostField(pid, 'uid'), 10) || 0;
	if (!uid || uid === parseInt(skipUid, 10)) {
		return [];
	}
	const canRead = await privileges.posts.can('topics:read', pid, uid);
	return canRead ? [uid] : [];
}

// Two independent tokens rather than one nested inside the other: compile()
// escapes the commas of an argument, which would turn a nested token's own
// arguments into part of its key. The translator resolves both tokens of a
// concatenated string just as happily.
function withCount(bodyShort, rest) {
	if (!rest) {
		return bodyShort;
	}
	const suffix = rest === 1 ?
		translator.compile('github-issue:notify.and-more-one') :
		translator.compile('github-issue:notify.and-more', rest);
	return `${bodyShort} ${suffix}`;
}

const pending = new Map();

/**
 * Queues one notification about a GitHub issue.
 *
 * `dedupe` must be derived from the GitHub payload (a comment id, a timestamp)
 * rather than from the delivery, so that the webhook and the poller produce the
 * same nid for the same event and no user is notified twice.
 *
 * Nothing is sent right away: a burst of actions on one issue - closing it
 * while also labelling and assigning it - would otherwise arrive as a string of
 * separate notifications. Events for the same issue are collected for a short
 * window and delivered as one. The window starts at the first event rather than
 * being extended by each new one, so a long spree cannot postpone the
 * notification indefinitely.
 */
notify.issueEvent = async function ({ issue, event, dedupe, bodyShort, url, skipUid }) {
	const config = await common.getConfig();
	if (!common.isNotifyEnabled(config, event)) {
		return;
	}
	const nid = `github-issue:${issue.id}:${event}:${dedupe}`;
	// re-creating a notification under an existing nid does not suppress it, it
	// puts it back at the top of the unread list - and both channels replay
	// events (GitHub's `since` is inclusive, webhook deliveries are retried), so
	// what has already been sent is tracked explicitly
	if (await db.isSortedSetMember(NOTIFIED_KEY, nid)) {
		return;
	}
	await db.sortedSetAdd(NOTIFIED_KEY, Date.now(), nid);

	const entry = { event: event, nid: nid, bodyShort: bodyShort, url: url || issue.url, skipUid: skipUid };
	const mergeMs = notify.getMergeSeconds(config) * 1000;
	if (!mergeMs) {
		await send(issue, [entry]);
		return;
	}
	const batch = pending.get(issue.id);
	if (batch) {
		batch.entries.push(entry);
		batch.issue = issue;
		return;
	}
	const created = { issue: issue, entries: [entry] };
	created.timer = setTimeout(() => {
		pending.delete(issue.id);
		send(created.issue, created.entries).catch(err => common.logError('sending notification failed', err));
	}, mergeMs);
	// a pending notification must never hold the process open on shutdown
	if (created.timer.unref) {
		created.timer.unref();
	}
	pending.set(issue.id, created);
};

async function send(issue, entries) {
	// an event the reader caused themselves is not news to them; when a merged
	// batch also holds events caused by others, it is still worth sending
	const skipUid = entries.every(entry => entry.skipUid) ? entries[0].skipUid : 0;
	const uids = await getRecipients(issue.pid, skipUid);
	if (!uids.length) {
		return;
	}
	// an event the reader caused makes a poor headline for a merged batch, so
	// it yields to one caused by somebody else
	entries.sort((a, b) => (a.skipUid ? 1 : 0) - (b.skipUid ? 1 : 0) ||
		EVENT_PRIORITY.indexOf(a.event) - EVENT_PRIORITY.indexOf(b.event));
	const lead = entries[0];
	const rest = entries.length - 1;
	const notification = await notifications.create({
		type: `github-issue-${lead.event}`,
		bodyShort: withCount(lead.bodyShort, rest),
		nid: lead.nid,
		path: rest ? issue.url : lead.url,
		icon: 'fa-github',
		pid: issue.pid,
		tid: issue.tid || undefined,
		// lets anything that still slipped through as a separate notification -
		// events further apart than the merge window, or observed by different
		// processes - be folded together again while it is still unread
		mergeId: `${MERGE_PREFIX}|${issue.id}`,
	});
	if (notification) {
		await notifications.push(notification, uids);
	}
}

notify.pruneSent = async function () {
	await db.sortedSetsRemoveRangeByScore([NOTIFIED_KEY], '-inf', Date.now() - NOTIFIED_TTL_MS);
};

/**
 * Persists a fresh snapshot of an issue and pushes it to everyone currently
 * viewing the topic, so an open topic reflects a GitHub change immediately.
 * This is deliberately not held back by the merge window: the sidebar should
 * always show what GitHub shows.
 */
notify.applyIssueUpdate = async function (issue, fields) {
	await issues.update(issue.id, { ...fields, stateCheckedAt: Date.now() });
	Object.assign(issue, fields);
	if (!issue.tid) {
		return;
	}
	websockets.in(`topic_${issue.tid}`).emit('event:github-issue.updated', {
		tid: issue.tid,
		issue: {
			id: issue.id,
			pid: issue.pid,
			url: issue.url,
			number: issue.number,
			title: issue.title,
			timestamp: issue.timestamp,
			state: issue.state,
			stateReason: issue.stateReason,
		},
	});
};

// Builders for the events both the webhook and the poller can detect. They are
// shared so that the two paths produce identical `event`/`dedupe` pairs.
notify.build = {
	opened: (issue, actor) => ({
		event: 'opened',
		dedupe: 'opened',
		bodyShort: translator.compile('github-issue:notify.opened', actor, issue.number, shorten(issue.title)),
	}),
	closed: (issue) => {
		const reason = issue.state_reason === 'not_planned' ? 'not-planned' :
			(issue.state_reason === 'duplicate' ? 'duplicate' : 'completed');
		return {
			event: 'closed',
			dedupe: `closed:${issue.closed_at || issue.updated_at || ''}`,
			bodyShort: translator.compile(`github-issue:notify.closed-${reason}`, issue.number, shorten(issue.title)),
		};
	},
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
notify.applySnapshot = async function (stored, fetched) {
	const state = fetched.state || '';
	const stateReason = fetched.state_reason || '';
	const title = fetched.title || '';
	const events = [];
	if (stored.state !== state) {
		events.push(state === 'closed' ? notify.build.closed(fetched) : notify.build.reopened(fetched));
	} else if (state === 'closed' && stored.stateReason !== stateReason) {
		events.push(notify.build.closed(fetched));
	}
	if (stored.title && stored.title !== title) {
		events.push(notify.build.renamed(fetched));
	}
	if (!events.length) {
		return false;
	}
	await notify.applyIssueUpdate(stored, { state: state, stateReason: stateReason, title: title });
	for (const event of events) {
		await notify.issueEvent({ issue: stored, ...event });
	}
	return true;
};

/**
 * Collapses the notifications of one issue that are still unread into a single
 * entry when the list is rendered. The merge window before sending keeps a
 * burst of actions down to one notification; this is the second half of it,
 * for updates that arrive far enough apart to be sent separately but are read
 * together anyway.
 */
notify.mergeNotifications = function (data) {
	const groups = new Map();
	data.notifications.forEach((notification) => {
		if (!notification || notification.read) {
			return;
		}
		const mergeId = notification.mergeId || '';
		if (mergeId.split('|')[0] !== MERGE_PREFIX) {
			return;
		}
		const group = groups.get(mergeId) || [];
		group.push(notification);
		groups.set(mergeId, group);
	});
	const dropped = new Set();
	groups.forEach((group) => {
		if (group.length < 2) {
			return;
		}
		// the entry keeps the position of the newest notification, but speaks
		// with the voice of the most significant event in the group
		const kept = group[0];
		const lead = group.slice().sort((a, b) => priorityOf(a) - priorityOf(b))[0];
		kept.bodyShort = withCount(lead.bodyShort, group.length - 1);
		group.slice(1).forEach(notification => dropped.add(notification));
	});
	if (dropped.size) {
		data.notifications = data.notifications.filter(notification => !dropped.has(notification));
	}
	return data;
};

function priorityOf(notification) {
	const index = EVENT_PRIORITY.indexOf(String(notification.type || '').replace('github-issue-', ''));
	return index === -1 ? EVENT_PRIORITY.length : index;
}
