# nodebb-plugin-github-issue

Adds an "Open GitHub issue" item to the post options menu. Authorized users can send a post's content to a new issue in a configured GitHub repository, after editing the title and body in a dialog.

## Features

- **Post menu button** — shown only to users holding the plugin's category privilege, and only when a repository + token are configured.
- **Edit before sending** — a dialog opens with the issue title (prefilled with the topic title) and body (prefilled with the raw post content and a link back to the post), both editable.
- **Write-only token** — the GitHub personal access token is stored server-side and can never be viewed again after saving; the admin page only shows whether a token is set and when.
- **Token expiry** — when saving the token, set a validity period in days (free text) or leave empty for no expiry. Administrators receive a notification 10 days before expiry and again when the token expires; issue creation is blocked while expired.
- **Permissions** — uses NodeBB's regular category privileges: grant the "Open GitHub issue from post" privilege (under the *other* section) to groups or individual users per category. Administrators always have it.

## Setup

1. Activate the plugin and rebuild.
2. In the ACP page (Plugins → GitHub Issue from Post) set the repository (`owner/repo`), optional labels, the token, and its validity in days.
3. Grant the privilege in Manage → Privileges for the relevant categories.

The token needs the `issues: write` (fine-grained) or `repo`/`public_repo` (classic) scope.
