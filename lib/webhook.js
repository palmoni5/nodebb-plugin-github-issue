'use strict';

const crypto = require('crypto');
const translator = require.main.require('./src/translator');

const common = require('./common');
const notify = require('./notify');

const webhook = module.exports;

webhook.ROUTE = '/github-issue/webhook';

const HANDLED_ISSUE_ACTIONS = new Set([
	'closed', 'reopened', 'edited',
	'labeled', 'unlabeled',
	'assigned', 'unassigned',
	'milestoned', 'demilestoned',
]);

function verifySignature(req, secret) {
	const received = req.get('X-Hub-Signature-256');
	if (!received || !req.rawBody) {
		return false;
	}
	const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
	const receivedBuf = Buffer.from(received);
	const expectedBuf = Buffer.from(expected);
	return receivedBuf.length === expectedBuf.length && crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

webhook.handler = async function (req, res) {
	const config = await common.getConfig();
	if (!config.webhookSecret) {
		return res.sendStatus(503);
	}
	if (!verifySignature(req, config.webhookSecret)) {
		return res.sendStatus(401);
	}
	const event = req.get('X-GitHub-Event');
	if (event === 'ping') {
		return res.sendStatus(204);
	}
	if (event !== 'issues' && event !== 'issue_comment') {
		return res.sendStatus(204);
	}
	// GitHub gives up on a delivery after 10 seconds, so acknowledge first and
	// do the forum-side work (privilege checks, notifications) detached
	res.sendStatus(202);
	processDelivery(req.body, event).catch(err => common.logError('webhook processing failed', err));
};

async function processDelivery(payload, event) {
	const issue = payload && payload.issue;
	const repo = payload && payload.repository && payload.repository.full_name;
	if (!issue || !repo || issue.pull_request) {
		return;
	}
	const pid = await common.getPidForIssue(repo, issue.number);
	if (!pid) {
		// an issue that was not opened from this forum
		return;
	}
	await notify.applyIssueUpdate(pid, {
		state: issue.state || '',
		stateReason: issue.state_reason || '',
		title: issue.title || '',
	});

	const built = event === 'issue_comment' ?
		buildComment(payload, issue) :
		buildIssueEvent(payload, issue);
	if (!built) {
		return;
	}
	await notify.issueEvent({ pid: pid, ...built });
}

function buildComment(payload, issue) {
	if (payload.action !== 'created' || !payload.comment) {
		return null;
	}
	return notify.build.comment(issue, payload.comment);
}

function buildIssueEvent(payload, issue) {
	const action = payload.action;
	if (!HANDLED_ISSUE_ACTIONS.has(action)) {
		return null;
	}
	switch (action) {
		case 'closed':
			return notify.build.closed(issue);
		case 'reopened':
			return notify.build.reopened(issue);
		case 'edited':
			// `edited` also fires for body-only edits, which are not worth a notification
			return payload.changes && payload.changes.title ? notify.build.renamed(issue) : null;
		case 'labeled':
		case 'unlabeled':
			return payload.label ? {
				event: 'labeled',
				dedupe: `label:${action}:${payload.label.name}:${issue.updated_at || ''}`,
				bodyShort: translator.compile(
					`github-issue:notify.${action}`,
					issue.number,
					notify.shorten(payload.label.name)
				),
			} : null;
		case 'assigned':
		case 'unassigned':
			return payload.assignee ? {
				event: 'assigned',
				dedupe: `assign:${action}:${payload.assignee.login}:${issue.updated_at || ''}`,
				bodyShort: translator.compile(
					`github-issue:notify.${action}`,
					issue.number,
					payload.assignee.login
				),
			} : null;
		case 'milestoned':
		case 'demilestoned':
			return {
				event: 'milestone',
				dedupe: `milestone:${action}:${issue.updated_at || ''}`,
				bodyShort: translator.compile(
					`github-issue:notify.${action}`,
					issue.number,
					notify.shorten((payload.milestone && payload.milestone.title) || (issue.milestone && issue.milestone.title) || '')
				),
			};
		default:
			return null;
	}
}
