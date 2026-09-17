'use strict';

const crypto = require('crypto');
const translator = require.main.require('./src/translator');

const common = require('./common');
const notify = require('./notify');
const issues = require('./issues');

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
	const ghIssue = payload && payload.issue;
	const repo = payload && payload.repository && payload.repository.full_name;
	if (!ghIssue || !repo || ghIssue.pull_request) {
		return;
	}
	const stored = await issues.getByNumber(repo, ghIssue.number);
	if (!stored) {
		// an issue that was not opened from this forum
		return;
	}
	await notify.applyIssueUpdate(stored, {
		state: ghIssue.state || '',
		stateReason: ghIssue.state_reason || '',
		title: ghIssue.title || '',
	});

	const config = await common.getConfig();
	const built = event === 'issue_comment' ?
		buildComment(payload, ghIssue) :
		buildIssueEvent(payload, ghIssue, config);
	if (!built) {
		return;
	}
	await notify.issueEvent({ issue: stored, ...built });
}

function buildComment(payload, ghIssue) {
	if (payload.action !== 'created' || !payload.comment) {
		return null;
	}
	return notify.build.comment(ghIssue, payload.comment);
}

function buildIssueEvent(payload, ghIssue, config) {
	const action = payload.action;
	if (!HANDLED_ISSUE_ACTIONS.has(action)) {
		return null;
	}
	switch (action) {
		case 'closed':
			return notify.build.closed(ghIssue);
		case 'reopened':
			return notify.build.reopened(ghIssue);
		case 'edited':
			// `edited` also fires for body-only edits, which are not worth a notification
			return payload.changes && payload.changes.title ? notify.build.renamed(ghIssue) : null;
		case 'labeled':
		case 'unlabeled':
			// the labels configured in the ACP are attached to every issue the
			// plugin opens, so reporting them back would be an echo of the
			// forum's own action rather than news about the issue
			if (!payload.label || common.isAutoLabel(config, payload.label.name)) {
				return null;
			}
			return {
				event: 'labeled',
				dedupe: `label:${action}:${payload.label.name}:${ghIssue.updated_at || ''}`,
				bodyShort: translator.compile(
					`github-issue:notify.${action}`,
					ghIssue.number,
					notify.shorten(payload.label.name)
				),
			};
		case 'assigned':
		case 'unassigned':
			return payload.assignee ? {
				event: 'assigned',
				dedupe: `assign:${action}:${payload.assignee.login}:${ghIssue.updated_at || ''}`,
				bodyShort: translator.compile(
					`github-issue:notify.${action}`,
					ghIssue.number,
					payload.assignee.login
				),
			} : null;
		case 'milestoned':
		case 'demilestoned':
			return {
				event: 'milestone',
				dedupe: `milestone:${action}:${ghIssue.updated_at || ''}`,
				bodyShort: translator.compile(
					`github-issue:notify.${action}`,
					ghIssue.number,
					notify.shorten((payload.milestone && payload.milestone.title) || (ghIssue.milestone && ghIssue.milestone.title) || '')
				),
			};
		default:
			return null;
	}
}
