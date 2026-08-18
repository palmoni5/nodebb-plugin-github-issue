'use strict';

define('admin/plugins/github-issue', ['alerts'], function (alerts) {
	const ACP = {};

	ACP.init = function () {
		$('#github-issue-save').on('click', function () {
			socket.emit('admin.plugins.githubIssue.save', {
				repo: $('#github-issue-repo').val(),
				labels: $('#github-issue-labels').val(),
				token: $('#github-issue-token').val(),
				expiryDays: $('#github-issue-expiry').val(),
			}, function (err, status) {
				if (err) {
					return alerts.error(err);
				}
				$('#github-issue-token').val('');
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
