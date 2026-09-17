# nodebb-plugin-github-issue

Adds an "Open GitHub issue" item to the post options menu. Authorized users can send a post's content to a new issue in a configured GitHub repository, after editing the title and body in a dialog.

## Features

- **Post menu button** — shown only to users holding the plugin's category privilege, and only when a repository + token are configured.
- **Edit before sending** — a dialog opens with the issue title (prefilled with the topic title) and body (prefilled with the raw post content and a link back to the post), both editable.
- **Duplicate warning** — before the issue is sent, the plugin searches the target repository for an issue with the same title. If one exists, a dialog lists the matching issues (linked) and offers to change the title or to create the issue anyway. A failed or rate-limited search never blocks creation; note that GitHub's search index can lag a minute or two behind very recently opened issues.
- **Write-only token** — the GitHub personal access token is stored server-side and can never be viewed again after saving; the admin page only shows whether a token is set and when.
- **Token expiry** — when saving the token, set a validity period in days (free text) or leave empty for no expiry. Administrators receive a notification 10 days before expiry and again when the token expires; issue creation is blocked while expired.
- **Topic sidebar** — every topic shows a sidebar panel listing the issues that were opened from its posts, each linking to the issue on GitHub and back to the originating post. Each issue shows a live status icon like on GitHub itself (green = open, purple check = closed, grey = closed as not planned); the status is fetched from GitHub server-side with the configured token and cached for 10 minutes. Visible only to users holding the plugin's privilege (or to all logged-in users if enabled in the plugin settings); it appears in the theme's sticky topic sidebar (large screens) or, on themes without one, in the widget sidebar area.
- **Post issue status icon** — posts that have an associated GitHub issue show a live status icon (open, closed, or closed as not planned) right next to the post's reply button with GitHub's exact Octicons and colors, linking directly to the issue on GitHub with an informative tooltip.
- **Issue update notifications** — the author of the post an issue was opened from gets a forum notification when the issue is opened (by somebody else; opening one from your own post notifies nobody), and when the issue is closed, reopened, renamed, commented on, labeled, assigned or added to a milestone. Which of those are sent is chosen per event in the ACP. See [Receiving updates from GitHub](#receiving-updates-from-github).
- **Permissions** — uses NodeBB's regular global privileges: grant the "Open GitHub issue from post" privilege (Manage → Privileges → Global Privileges, under the *other* section) to groups or individual users. Users also need read access to the post. Administrators always have it.

## Setup

1. Activate the plugin and rebuild.
2. In the ACP page (Plugins → GitHub Issue from Post) set the repository (`owner/repo`), optional labels, the token, and its validity in days.
3. Grant the privilege in Manage → Privileges → Global Privileges.

The token needs the `issues: write` (fine-grained) or `repo`/`public_repo` (classic) scope.

## Receiving updates from GitHub

Out of the box the plugin only *sends* to GitHub; to learn what happens to an issue afterwards it needs one of the two channels below. Both can be enabled at once — every notification is keyed by the GitHub event it describes, so an event observed by both channels is still only notified about once.

Which events produce a notification is configured in the ACP under *Notifications*. A post can have any number of issues opened from it, and each is tracked separately.

Several actions on one issue in quick succession arrive as a single notification: updates are held for a short window (60 seconds by default, configurable, 0 to disable) before being sent, and anything that still arrives separately is merged again while it is unread. The labels configured in the settings are attached by the plugin to every issue it opens, so they never produce a notification of their own.

The recipient is the author of the post the issue was opened from — whoever pressed the button can already watch the issue on GitHub. An author who has since lost read access to the post is skipped.

### Webhook (recommended)

Instant, costs no API quota, and keeps working after the issue-creation token expires.

1. In the ACP, set a **webhook secret** (a long random string) and copy the **payload URL** shown above it.
2. In the repository: *Settings → Webhooks → Add webhook*.
3. Payload URL: the URL from step 1. Content type: `application/json`. Secret: the same secret.
4. Under "Let me select individual events", tick **Issues** and **Issue comments**.

Deliveries are authenticated with GitHub's `X-Hub-Signature-256` HMAC over the raw request body; unsigned or badly signed deliveries are rejected, and no delivery is accepted at all while no secret is set. This requires the forum to be reachable from the internet.

### Polling

For forums GitHub cannot reach. Enable it in the ACP and set an interval (default 5 minutes). The plugin asks GitHub for everything that changed since the previous run — two requests per interval regardless of how many issues are tracked, sent with `If-None-Match` so unchanged results cost no rate limit at all.

Polling detects closing (including the reason), reopening, renaming and new comments. Label, assignee and milestone changes are only visible over the webhook. No extra permission is needed: the token that creates issues can already read them.

Polling runs only on the primary process, so a clustered forum does not notify its users several times.

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
