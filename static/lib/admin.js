'use strict';

define('admin/plugins/github-issue', ['alerts'], function (alerts) {
	const ACP = {};

	ACP.init = function () {
		$('#github-issue-webhook-url').on('focus click', function () {
			this.select();
		});

		$('#github-issue-save').on('click', function () {
			const notifyEvents = $('[data-notify-event]:checked').map(function () {
				return $(this).attr('data-notify-event');
			}).get();
			socket.emit('admin.plugins.githubIssue.save', {
				repo: $('#github-issue-repo').val(),
				labels: $('#github-issue-labels').val(),
				token: $('#github-issue-token').val(),
				expiryDays: $('#github-issue-expiry').val(),
				publicSidebar: $('#github-issue-public-sidebar').is(':checked'),
				notifyEvents: notifyEvents,
				mergeSeconds: $('#github-issue-merge-seconds').val(),
				webhookSecret: $('#github-issue-webhook-secret').val(),
				clearWebhookSecret: $('#github-issue-webhook-secret-clear').is(':checked'),
				pollEnabled: $('#github-issue-poll-enabled').is(':checked'),
				pollMinutes: $('#github-issue-poll-minutes').val(),
			}, function (err, status) {
				if (err) {
					return alerts.error(err);
				}
				$('#github-issue-token').val('');
				$('#github-issue-webhook-secret').val('');
				if (status && status.tokenSet) {
					$('#github-issue-token').attr('placeholder', '••••••••••••');
				}
				alerts.success('[[github-issue:admin.saved]]');
				ajaxify.refresh();
			});
		});
	};

	return ACP;
});
