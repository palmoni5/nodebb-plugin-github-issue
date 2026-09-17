'use strict';

const db = require.main.require('./src/database');

const common = require('./common');

const issues = module.exports;

function shape(id, data) {
	if (!data || !data.url) {
		return null;
	}
	return {
		id: id,
		pid: parseInt(data.pid, 10) || 0,
		tid: parseInt(data.tid, 10) || 0,
		uid: parseInt(data.uid, 10) || 0,
		url: data.url,
		number: parseInt(data.number, 10) || 0,
		title: data.title || '',
		timestamp: parseInt(data.timestamp, 10) || 0,
		state: data.state || '',
		stateReason: data.stateReason || '',
		stateCheckedAt: parseInt(data.stateCheckedAt, 10) || 0,
	};
}

/**
 * Issues used to be stored one per post, which silently dropped the first one
 * when a second issue was opened from the same post. They now live under their
 * own key with a per-post list pointing at them; a post still holding only the
 * old single object is moved over the first time it is read, so nothing that
 * was already recorded is lost and no migration step is needed.
 */
async function promoteLegacy(pid) {
	const legacy = await db.getObject(common.PID_KEY_PREFIX + pid);
	if (!legacy || !legacy.url) {
		return [];
	}
	const repo = common.repoFromIssueUrl(legacy.url);
	if (!repo || !legacy.number) {
		return [];
	}
	const id = common.indexField(repo, legacy.number);
	const data = { ...legacy, pid: parseInt(pid, 10) };
	await Promise.all([
		db.setObject(common.ISSUE_KEY_PREFIX + id, data),
		db.sortedSetAdd(common.pidListKey(pid), parseInt(legacy.timestamp, 10) || Date.now(), id),
		common.indexIssue(repo, legacy.number, pid),
	]);
	return [shape(id, data)].filter(Boolean);
}

issues.listForPid = async function (pid) {
	const ids = await db.getSortedSetRange(common.pidListKey(pid), 0, -1);
	if (!ids.length) {
		return promoteLegacy(pid);
	}
	const objects = await db.getObjects(ids.map(id => common.ISSUE_KEY_PREFIX + id));
	return objects.map((data, i) => shape(ids[i], data)).filter(Boolean);
};

issues.listForPids = async function (pids) {
	const lists = await Promise.all(pids.map(pid => issues.listForPid(pid)));
	return lists.flat();
};

issues.getByNumber = async function (repo, number) {
	const id = common.indexField(repo, number);
	const direct = await db.getObject(common.ISSUE_KEY_PREFIX + id);
	if (direct && direct.url) {
		return shape(id, direct);
	}
	// not promoted yet: the reverse index still points at the post
	const pid = await common.getPidForIssue(repo, number);
	if (!pid) {
		return null;
	}
	const list = await issues.listForPid(pid);
	return list.find(issue => issue.id === id) || null;
};

issues.add = async function ({ pid, tid, uid, url, number, title, timestamp, repo }) {
	const id = common.indexField(repo, number);
	const data = {
		pid: parseInt(pid, 10),
		tid: parseInt(tid, 10) || 0,
		uid: parseInt(uid, 10) || 0,
		url: url,
		number: number,
		title: title,
		timestamp: timestamp,
		state: 'open',
		stateReason: '',
		stateCheckedAt: timestamp,
	};
	await Promise.all([
		db.setObject(common.ISSUE_KEY_PREFIX + id, data),
		db.sortedSetAdd(common.pidListKey(pid), timestamp, id),
		common.indexIssue(repo, number, pid),
	]);
	return shape(id, data);
};

issues.update = async function (id, fields) {
	await db.setObject(common.ISSUE_KEY_PREFIX + id, fields);
};
