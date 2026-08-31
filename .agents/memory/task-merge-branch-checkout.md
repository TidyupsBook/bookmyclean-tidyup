---
name: Task merges can strand the workspace on main
description: After a project-task merge, verify HEAD is on the working branch; a wrong checkout mimics huge regressions.
---

The rule: when whole features "suddenly disappear" or test counts collapse right after a task merge, check the current branch before debugging code. The merge process can leave the workspace checked out on the stale `main` instead of the working branch (`book-my-cleaning`), which makes newer pages, tests, and features vanish at once while nothing is actually lost.

**Why:** This happened once and looked exactly like a mass code regression; everything was intact on the working branch's remote.

**How to apply:** Check out the working branch, then restart the API server and web workflows — the API binary was built from the wrong code. Same family as the known orphaned-port problem after merges: treat post-merge weirdness as environment first, code second.
