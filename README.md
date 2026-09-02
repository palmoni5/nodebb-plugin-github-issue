# nodebb-plugin-github-issue

Adds an "Open GitHub issue" item to the post options menu. Authorized users can send a post's content to a new issue in a configured GitHub repository, after editing the title and body in a dialog.

## Features

- **Post menu button** — shown only to users holding the plugin's category privilege, and only when a repository + token are configured.
- **Edit before sending** — a dialog opens with the issue title (prefilled with the topic title) and body (prefilled with the raw post content and a link back to the post), both editable.
- **Duplicate warning** — before the issue is sent, the plugin searches the target repository for an issue with the same title. If one exists, a dialog lists the matching issues (linked) and offers to change the title or to create the issue anyway. A failed or rate-limited search never blocks creation; note that GitHub's search index can lag a minute or two behind very recently opened issues.
- **Write-only token** — the GitHub personal access token is stored server-side and can never be viewed again after saving; the admin page only shows whether a token is set and when.
- **Token expiry** — when saving the token, set a validity period in days (free text) or leave empty for no expiry. Administrators receive a notification 10 days before expiry and again when the token expires; issue creation is blocked while expired.
- **Topic sidebar** — every topic shows a sidebar panel listing the issues that were opened from its posts, each linking to the issue on GitHub and back to the originating post. Each issue shows a live status icon like on GitHub itself (green = open, purple check = closed, grey = closed as not planned); the status is fetched from GitHub server-side with the configured token and cached for 10 minutes. Visible only to users holding the plugin's privilege (or to all logged-in users if enabled in the plugin settings); it appears in the theme's sticky topic sidebar (large screens) or, on themes without one, in the widget sidebar area.
- **Permissions** — uses NodeBB's regular global privileges: grant the "Open GitHub issue from post" privilege (Manage → Privileges → Global Privileges, under the *other* section) to groups or individual users. Users also need read access to the post. Administrators always have it.

## Setup

1. Activate the plugin and rebuild.
2. In the ACP page (Plugins → GitHub Issue from Post) set the repository (`owner/repo`), optional labels, the token, and its validity in days.
3. Grant the privilege in Manage → Privileges → Global Privileges.

The token needs the `issues: write` (fine-grained) or `repo`/`public_repo` (classic) scope.

## Labels with a token that has no push access

GitHub only honours the `labels` field of the create-issue API when the token's account has push/triage access to the repository — otherwise the labels are **silently dropped**. To make labels work with an unprivileged token, the plugin also embeds the configured labels as a hidden marker in the issue body:

```
<!-- forum-labels: bug, from-forum -->
```

Add this workflow to the target repository as `.github/workflows/forum-labels.yml` (one-time setup by someone with write access to the repo). It runs with the repository's own `GITHUB_TOKEN`, which is always allowed to set labels:

```yaml
name: Apply forum labels

on:
  issues:
    types: [opened]

permissions:
  issues: write

jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const body = context.payload.issue.body || '';
            const match = body.match(/<!--\s*forum-labels:\s*([^>]*?)\s*-->/);
            if (!match) return;
            const labels = match[1].split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
            if (!labels.length) return;
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.issue.number,
              labels,
            });
```

Notes:

- When the token *does* have push access the labels are applied twice (API field + workflow) — that is harmless, the result is the same.
- The marker is plain issue-body text, so anyone who can open issues in the repo could add such a marker by hand to label their own issue. If that matters, whitelist the allowed labels inside the workflow script.
- `addLabels` creates labels that do not exist yet in the repository.
