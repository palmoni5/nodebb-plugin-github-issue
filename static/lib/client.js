'use strict';

$(document).ready(function () {
	if (window.__githubIssueBound) {
		return;
	}
	window.__githubIssueBound = true;

	$(document).on('click', '[component="post/github-issue"]', function (e) {
		e.preventDefault();
		const postEl = $(this).closest('[data-pid]');
		const pid = postEl.attr('data-pid');
		if (!pid) {
			return;
		}
		require(['api', 'bootbox', 'alerts', 'translator'], function (api, bootbox, alerts, translator) {
			api.get('/posts/' + encodeURIComponent(pid) + '/raw', {}).then(function (data) {
				openDialog(pid, (data && data.content) || '', bootbox, alerts, translator);
			}).catch(alerts.error);
		});
	});

	function openDialog(pid, content, bootbox, alerts, translator) {
		const keys = [
			'[[github-issue:dialog-title]]',
			'[[github-issue:issue-title]]',
			'[[github-issue:issue-body]]',
			'[[github-issue:submit]]',
			'[[modules:bootbox.cancel]]',
			'[[github-issue:created]]',
		];
		Promise.all(keys.map(function (key) {
			return new Promise(function (resolve) {
				translator.translate(key, resolve);
			});
		})).then(function (t) {
			const postUrl = window.location.origin + config.relative_path + '/post/' + encodeURIComponent(pid);
			const defaultTitle = (ajaxify.data && (ajaxify.data.titleRaw || ajaxify.data.title)) || '';
			const defaultBody = content + '\n\n---\n' + postUrl;

			const form = $('<form class="github-issue-form"></form>');
			const titleGroup = $('<div class="mb-3"></div>');
			titleGroup.append($('<label class="form-label"></label>').text(t[1]));
			const titleInput = $('<input type="text" class="form-control" maxlength="256">').val(defaultTitle);
			titleGroup.append(titleInput);
			const bodyGroup = $('<div class="mb-3"></div>');
			bodyGroup.append($('<label class="form-label"></label>').text(t[2]));
			const bodyInput = $('<textarea class="form-control" rows="12"></textarea>').val(defaultBody);
			bodyGroup.append(bodyInput);
			form.append(titleGroup).append(bodyGroup);

			bootbox.dialog({
				title: t[0],
				message: form,
				onEscape: true,
				buttons: {
					cancel: {
						label: t[4],
						className: 'btn-link',
					},
					submit: {
						label: t[3],
						className: 'btn-primary',
						callback: function () {
							const title = titleInput.val().trim();
							const body = bodyInput.val();
							if (!title) {
								titleInput.addClass('is-invalid').focus();
								return false;
							}
							socket.emit('plugins.githubIssue.create', {
								pid: pid,
								title: title,
								body: body,
							}, function (err, result) {
								if (err) {
									return alerts.error(err);
								}
								alerts.alert({
									type: 'success',
									title: t[5] + ' — #' + result.number,
									message: result.url,
									timeout: 10000,
									clickfn: function () {
										window.open(result.url, '_blank', 'noopener');
									},
								});
							});
						},
					},
				},
			});
		});
	}
});
