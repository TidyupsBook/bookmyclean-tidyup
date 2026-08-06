---
name: Pushing to GitHub from a Replit workspace
description: Why gitPush fails with NO_REMOTE / UNAUTHENTICATED here, and which GitHub connection actually grants push access.
---

# Pushing to GitHub

## The remote is not called `origin`

`gitPush` auto-detects the remote by looking for `origin`. A Replit workspace's real
GitHub remote is named `subrepl-<id>`, and dozens of sibling `subrepl-*` remotes point
at the local workspace over ssh (they are not GitHub). So `gitPush` returns `NO_REMOTE`
out of the box.

Adding an `origin` alias to the same URL is not enough on its own — if the branch still
tracks `subrepl-<id>/main`, `gitPush` refuses with
`current branch already tracks <remote>; cannot publish`. The branch upstream must also
point at `origin/main`.

**Why:** the callback resolves both the remote *and* the tracking branch through `origin`.

**How to apply:** add `origin` with the same GitHub URL, then
`git branch --set-upstream-to=origin/main main`. If `git fetch origin` fails for
credentials, seed the tracking ref locally with
`git update-ref refs/remotes/origin/main refs/remotes/<subrepl-remote>/main` — the two
remotes are the same repository.

## `UNAUTHENTICATED` usually means the repo does not exist

GitHub answers requests for a repository you cannot see with an auth error rather than a
"not found", so `gitPush` reporting `CLI_ERROR: UNAUTHENTICATED` is **not** evidence that
credentials are missing. Check that the remote URL names a repository that actually
exists before touching credentials or proposing a connector.

**Why:** GitHub deliberately hides the existence of inaccessible repos. A one-character
difference in the remote URL is indistinguishable from a permissions failure.

**How to apply:** hit `GET /repos/{owner}/{repo}` through the GitHub connector. A 404
there while other repos return 200 means the name is wrong, not the token. Listing
`/user/repos` reveals near-miss names (hyphen placement, casing).

## `origin` gets rewritten underneath you — always check where the push landed

The workspace Git pane owns the `origin` remote and silently resets its URL to whatever
repo the workspace is currently linked to. A `git remote set-url origin ...` from the
shell can be reverted before the next `gitPush`, which then reports **success** while
pushing somewhere else entirely.

**Why:** `gitPush` honours `origin` at the moment it runs, and the pane rewrites it
whenever the user links or creates a repo there. Success is reported against the remote
actually used, not the one that was requested.

**How to apply:** read the `remote` field in the `gitPush` result and compare it to the
intended URL — never treat `success: true` alone as proof. Confirm the branch head on
GitHub matches local HEAD. When the target must be specific, set the remote URL and call
`gitPush` inside a single CodeExecution call so nothing can intervene between them.

## The GitHub connector does not grant push access

Authorizing the GitHub **integration/connector** (the one from `searchIntegrations`)
gives API access through the connectors proxy. It does **not** give git push
credentials — `gitPush` still fails with `CLI_ERROR: UNAUTHENTICATED` afterwards.
Push access comes from the workspace **Git pane's** GitHub account link, which is a
separate, user-only UI action.

Raw `git push` / `git fetch` from a shell has no credentials at all and fails with
`Invalid username or token`; there is no credential helper configured.

**Why:** two independent GitHub auth surfaces exist — connectors (API) and the Git pane
(transport). They are not interchangeable.

**How to apply:** if a push is needed and `gitPush` returns `UNAUTHENTICATED`, stop
retrying and send the user to the Git pane rather than proposing the GitHub connector.

## Unrelated histories

A freshly created GitHub repo may hold a single placeholder `README.md` commit with no
common ancestor. Merging needs `--allow-unrelated-histories`; ask before force-pushing,
since that discards the remote commit.
