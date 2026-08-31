---
name: User uploads land in a public repo
description: attached_assets is tracked and auto-committed; uploaded files carrying personal data must be ignored before any push
---

Anything the user drops into the workspace lands in `attached_assets/`, which is
**tracked**, and the platform makes its own commit for it ("Add <file> asset
configuration") without being asked. The GitHub remote for this project is public.

**Why:** a staff export (real names, mobile numbers, home addresses) was committed
that way within minutes of being uploaded, and would have been published by the next
routine push.

**How to apply:** whenever an upload contains personal data — staff or customer
records, exports from another system, screenshots of a live inbox — check
`git check-ignore` on it *before* pushing. If it is tracked, add a pattern to
`.gitignore` and strip it from history while the commit is still local: verify it is
unpushed by comparing against `git ls-remote origin <branch>`, then
`git rebase --onto <parent> <the asset commit> <branch>`. The rebase deletes the file
from the working tree, so copy it aside first and put it back afterwards; the user
still wants their upload, just not in the repo. Files generated *for* the user from
that data (CSV exports, cleaned rosters) need the same treatment — write them
somewhere ignored.
