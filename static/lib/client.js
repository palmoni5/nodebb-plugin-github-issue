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

	// GitHub's own issue icons (Octicons, MIT licensed: primer/octicons),
	// embedded inline so no external assets are loaded
	const OCTICONS = {
		open: {
			color: '#1a7f37',
			paths: [
				'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
				'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z',
			],
		},
		closed: {
			color: '#8250df',
			paths: [
				'M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z',
				'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z',
			],
		},
		notPlanned: {
			color: '#59636e',
			paths: [
				'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z',
			],
		},
	};

	function buildStateIcon(issue, stateLabels) {
		let icon;
		let label;
		if (issue.state === 'open') {
			icon = OCTICONS.open;
			label = stateLabels.open;
		} else if (issue.state === 'closed' && issue.stateReason === 'not_planned') {
			icon = OCTICONS.notPlanned;
			label = stateLabels.not_planned;
		} else if (issue.state === 'closed') {
			icon = OCTICONS.closed;
			label = stateLabels.closed;
		} else {
			return null;
		}
		const svg = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor" style="vertical-align: -0.125em;">' +
			icon.paths.map(function (d) {
				return '<path d="' + d + '"></path>';
			}).join('') +
			'</svg>';
		return $('<span class="me-1"></span>')
			.css('color', icon.color)
			.attr('title', label)
			.append($(svg));
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
			'[[github-issue:duplicate-title]]',
			'[[github-issue:duplicate-warning]]',
			'[[github-issue:duplicate-suggestion]]',
			'[[github-issue:duplicate-change]]',
			'[[github-issue:duplicate-create-anyway]]',
			'[[github-issue:checking-duplicates]]',
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

			// the title the user already confirmed as an intentional duplicate
			let confirmedTitle = null;

			const dialog = bootbox.dialog({
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
						className: 'btn-primary github-issue-submit',
						// the dialog is closed by hand once the issue is created, so
						// that it stays open (with the typed text) on failure and
						// while the duplicate check runs
						callback: function () {
							onSubmit();
							return false;
						},
					},
				},
			});

			const submitBtn = dialog.find('.github-issue-submit');

			function setBusy(busy) {
				submitBtn.prop('disabled', busy).text(busy ? t[11] : t[3]);
			}

			function normalize(value) {
				return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
			}

			function onSubmit() {
				const title = titleInput.val().trim();
				const body = bodyInput.val();
				if (!title) {
					titleInput.addClass('is-invalid').focus();
					return;
				}
				if (confirmedTitle !== null && normalize(confirmedTitle) === normalize(title)) {
					createIssue(title, body);
					return;
				}
				setBusy(true);
				socket.emit('plugins.githubIssue.findDuplicates', { title: title }, function (err, matches) {
					setBusy(false);
					// a failed duplicate check must not block issue creation
					if (!err && Array.isArray(matches) && matches.length) {
						warnDuplicates(matches, title, body);
						return;
					}
					createIssue(title, body);
				});
			}

			function warnDuplicates(matches, title, body) {
				const message = $('<div></div>');
				message.append($('<p class="mb-2"></p>').text(t[7]));
				const list = $('<ul class="mb-2"></ul>');
				matches.forEach(function (match) {
					list.append(
						$('<li></li>').append(
							$('<a target="_blank" rel="noopener noreferrer"></a>')
								.attr('href', match.url)
								.text('#' + match.number + ' ' + (match.title || ''))
						)
					);
				});
				message.append(list);
				message.append($('<p class="mb-0 text-muted"></p>').text(t[8]));

				bootbox.dialog({
					title: t[6],
					message: message,
					onEscape: true,
					buttons: {
						change: {
							label: t[9],
							className: 'btn-primary',
							callback: function () {
								// focus once the confirm dialog has finished closing,
								// otherwise it takes the focus back with it
								setTimeout(function () {
									titleInput.focus().select();
								}, 300);
							},
						},
						createAnyway: {
							label: t[10],
							className: 'btn-link',
							callback: function () {
								confirmedTitle = title;
								createIssue(title, body);
							},
						},
					},
				});
			}

			function createIssue(title, body) {
				setBusy(true);
				socket.emit('plugins.githubIssue.create', {
					pid: pid,
					title: title,
					body: body,
				}, function (err, result) {
					setBusy(false);
					if (err) {
						return alerts.error(err);
					}
					dialog.modal('hide');
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
			}
		});
	}
});
