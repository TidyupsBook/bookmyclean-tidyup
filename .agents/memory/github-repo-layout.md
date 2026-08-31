---
name: GitHub repo layout for this project
description: Which GitHub repo/branch actually holds the code, and why `main` looks empty or stale.
---

The project's real history lives on the **`book-my-cleaning`** branch, not `main`.

- `main` in the GitHub repos is either an empty "Initial commit" (0 files) or a stale early snapshot. A repo's landing page therefore looks empty even when the code is there — always check the branch list before concluding a push failed.
- Locally, `main` is an ancestor of `book-my-cleaning`; checking out `main` silently strips weeks of work out of the working tree (and out of the running preview), with no warning beyond a clean `git status`.
- More than one GitHub repo has been created for this project, and at least one was left completely empty while `origin` still pointed at it. Stale `refs/remotes/origin/*` entries can point at a *different* repo than the current `origin` URL — verify with `git ls-remote <url>`, not with the tracking refs.

**Why:** the app is exported/pushed from more than one Replit workspace, so parallel copies of `book-my-cleaning` exist and drift apart.

**How to apply:** before comparing, pushing, or "restoring" anything, confirm (1) which branch is checked out, (2) what the remote URL actually resolves to, and (3) whether the other copy has commits this one lacks. When merging two copies, expect **duplicate migration numbers** — each copy keeps numbering from the split point, so the same `00NN_` prefix means two different migrations. Renumber before merging or the startup migration runner applies the wrong set.

Git flags neither of the two things that actually bite here: differently-named
migration files merge without a conflict despite claiming the same number, and
the copies can have drifted onto **contradictory domain rules** that auto-merge
cleanly (one line tightened what a booking status may be at creation while the
other started sending the now-forbidden value). After any such merge, re-read
the invariants each side added and run the full suite — a green `git merge` says
nothing about them.
