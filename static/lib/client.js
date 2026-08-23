'use strict';

$(document).ready(function () {
	if (window.__githubIssueBound) {
		return;
	}
	window.__githubIssueBound = true;

	$(window).on('action:ajaxify.end', renderTopicIssues);
	if (window.ajaxify && ajaxify.data) {
		renderTopicIssues();
	}

	function renderTopicIssues() {
		$('.github-issue-topic-sidebar').remove();
		if (!ajaxify.data || ajaxify.data.template.name !== 'topic') {
			return;
		}
		const issues = ajaxify.data.githubIssues;
		if (!Array.isArray(issues) || !issues.length) {
			return;
		}
		require(['translator'], function (translator) {
			translator.translate('[[github-issue:topic-issues]]|[[github-issue:from-post]]|[[github-issue:state-open]]|[[github-issue:state-closed]]|[[github-issue:state-not-planned]]', function (translated) {
				const parts = translated.split('|');
				const heading = parts[0];
				const fromPost = parts[1];
				const stateLabels = { open: parts[2], closed: parts[3], 'not_planned': parts[4] };
				const panel = $('<div class="github-issue-topic-sidebar d-flex flex-column gap-1"></div>');
				panel.append(
					$('<div class="fw-semibold text-xs text-muted text-nowrap"></div>')
						.append($('<i class="fa fa-github me-1"></i>'))
						.append($('<span></span>').text(heading + ' (' + issues.length + ')'))
				);
				const list = $('<ul class="list-unstyled m-0 d-flex flex-column gap-1"></ul>');
				issues.forEach(function (issue) {
					const label = '#' + issue.number + (issue.title ? ' ' + issue.title : '');
					const link = $('<a class="d-block text-truncate" target="_blank" rel="noopener noreferrer"></a>')
						.attr('href', issue.url)
						.attr('title', label)
						.text(label);
					const stateIcon = buildStateIcon(issue, stateLabels);
					if (stateIcon) {
						link.prepend(stateIcon);
						link.attr('title', stateIcon.attr('title') + ' — ' + label);
					}
					const item = $('<li></li>').append(link);
					if (issue.pid) {
						item.append(
							$('<a class="d-block text-xs text-muted"></a>')
								.attr('href', config.relative_path + '/post/' + issue.pid)
								.text(fromPost)
						);
					}
					list.append(item);
				});
				panel.append(list);
				placePanel(panel);
			});
		});
	}

	// mirrors GitHub's own issue icons: green open circle, purple check for
	// closed-as-completed, grey slashed circle for closed-as-not-planned
	function buildStateIcon(issue, stateLabels) {
		if (issue.state === 'open') {
			return $('<i class="fa fa-circle-dot me-1" style="color: #1a7f37;"></i>').attr('title', stateLabels.open);
		}
		if (issue.state === 'closed') {
			if (issue.stateReason === 'not_planned') {
				return $('<i class="fa fa-ban me-1 text-muted"></i>').attr('title', stateLabels.not_planned);
			}
			return $('<i class="fa fa-circle-check me-1" style="color: #8250df;"></i>').attr('title', stateLabels.closed);
		}
		return null;
	}

	function placePanel(panel) {
		// harmony's sticky topic sidebar column, hidden below lg
		const sticky = $('.sticky-top .flex-column.align-items-end').first();
		if (sticky.length) {
			panel.addClass('ps-2').css({ 'min-width': '170px', 'max-width': '240px' });
			sticky.append($('<hr class="my-0" style="min-width: 170px;" />').addClass('github-issue-topic-sidebar'))
				.append(panel);
			return;
		}
		const widgetArea = $('[data-widget-area="sidebar"]').first();
		if (widgetArea.length) {
			widgetArea.removeClass('hidden');
			panel.addClass('card card-body p-3 mb-3');
			widgetArea.prepend(panel);
			return;
		}
		panel.addClass('card card-body p-3 mb-3');
		$('[component="topic"]').first().before(panel);
	}

	$(document).on('click', '[component="post/github-issue"]', function (e) {
		e.preventDefault();
		const postEl = $(this).closest('[data-pid]');
		const pid = postEl.attr('data-pid');
		if (!pid) {
			return;
		}
		require(['api', 'bootbox', 'alerts', 'translator'], function (api, bootbox, alerts, translator) {
			const existingPromise = new Promise(function (resolve) {
				socket.emit('plugins.githubIssue.getExisting', { pid: pid }, function (err, existing) {
					resolve(err ? null : existing);
				});
			});
			Promise.all([
				api.get('/posts/' + encodeURIComponent(pid) + '/raw', {}),
				existingPromise,
			]).then(function (results) {
				openDialog(pid, (results[0] && results[0].content) || '', results[1], bootbox, alerts, translator);
			}).catch(alerts.error);
		});
	});

	function openDialog(pid, content, existing, bootbox, alerts, translator) {
		const keys = [
			'[[github-issue:dialog-title]]',
			'[[github-issue:issue-title]]',
			'[[github-issue:issue-body]]',
			'[[github-issue:submit]]',
			'[[modules:bootbox.cancel]]',
			'[[github-issue:created]]',
			'[[github-issue:already-opened]]',
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
			if (existing && existing.url) {
				const warning = $('<div class="alert alert-warning d-flex align-items-center gap-2 mb-3"></div>');
				warning.append($('<i class="fa fa-exclamation-triangle"></i>'));
				warning.append($('<span></span>').text(t[6]));
				warning.append(
					$('<a target="_blank" rel="noopener noreferrer"></a>')
						.attr('href', existing.url)
						.text('#' + existing.number)
				);
				form.append(warning);
			}
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
								if (ajaxify.data && ajaxify.data.template.name === 'topic') {
									ajaxify.data.githubIssues = (ajaxify.data.githubIssues || []).concat(result);
									renderTopicIssues();
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
