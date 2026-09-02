<div class="acp-page-container">
	<div class="row m-0">
		<div id="spy-container" class="col-12 px-0 mb-4" tabindex="0">
			<h4 class="fw-bold tracking-tight settings-header">{{tx("github-issue:admin.title")}}</h4>
			<p class="text-secondary">{{tx("github-issue:admin.description")}}</p>

			<div class="alert {{{ if expired }}}alert-danger{{{ else }}}{{{ if tokenSet }}}alert-success{{{ else }}}alert-warning{{{ end }}}{{{ end }}}" component="github-issue/status">
				{{{ if tokenSet }}}
					{{{ if expired }}}
						{{tx("github-issue:admin.status-expired", expiresAtDate)}}
					{{{ else }}}
						{{tx("github-issue:admin.status-set", tokenSetAt)}}
						{{{ if hasExpiry }}}
							&mdash; {{tx("github-issue:admin.status-expires", expiresAtDate, daysLeft)}}
						{{{ else }}}
							&mdash; {{tx("github-issue:admin.status-no-expiry")}}
						{{{ end }}}
					{{{ end }}}
				{{{ else }}}
					{{tx("github-issue:admin.status-not-set")}}
				{{{ end }}}
			</div>

			<form role="form" class="github-issue-settings">
				<div class="mb-3">
					<label class="form-label" for="github-issue-repo">{{tx("github-issue:admin.repo")}}</label>
					<input type="text" id="github-issue-repo" class="form-control" placeholder="owner/repository" value="{repo}" dir="ltr" />
					<p class="form-text">{{tx("github-issue:admin.repo-help")}}</p>
				</div>
				<div class="mb-3">
					<label class="form-label" for="github-issue-labels">{{tx("github-issue:admin.labels")}}</label>
					<input type="text" id="github-issue-labels" class="form-control" placeholder="bug, from-forum" value="{labels}" dir="ltr" />
					<p class="form-text">{{tx("github-issue:admin.labels-help")}}</p>
				</div>
				<div class="mb-3">
					<label class="form-label" for="github-issue-token">{{tx("github-issue:admin.token")}}</label>
					<input type="password" id="github-issue-token" class="form-control" autocomplete="new-password" dir="ltr" {{{ if tokenSet }}}placeholder="••••••••••••"{{{ end }}} />
					<p class="form-text">{{tx("github-issue:admin.token-help")}}</p>
				</div>
				<div class="mb-3">
					<label class="form-label" for="github-issue-expiry">{{tx("github-issue:admin.expiry")}}</label>
					<input type="text" id="github-issue-expiry" class="form-control" value="{expiryDays}" dir="ltr" />
					<p class="form-text">{{tx("github-issue:admin.expiry-help")}}</p>
				</div>
				<div class="form-check form-switch mb-3">
					<input class="form-check-input" type="checkbox" id="github-issue-public-sidebar" {{{ if publicSidebar }}}checked{{{ end }}} />
					<label class="form-check-label" for="github-issue-public-sidebar">{{tx("github-issue:admin.public-sidebar")}}</label>
					<p class="form-text">{{tx("github-issue:admin.public-sidebar-help")}}</p>
				</div>
				<button type="button" id="github-issue-save" class="btn btn-primary">{{tx("github-issue:admin.save")}}</button>
			</form>

			<hr/>
			<p class="text-secondary">{{tx("github-issue:admin.privilege-help")}}</p>
		</div>
	</div>
</div>
