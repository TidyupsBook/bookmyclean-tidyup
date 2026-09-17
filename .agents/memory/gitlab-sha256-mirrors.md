---
name: GitLab SHA-256 mirrors
description: How to mirror a SHA-1 workspace into a GitLab repository that enforces SHA-256 objects.
---

When GitLab reports a 64-character commit id and Git fails with `mismatched algorithms: client sha1; server sha256`, create a temporary repository with SHA-256 objects and transfer the branch through `git fast-export` and `git fast-import`. Push from that temporary repository.

**Why:** Git cannot directly fetch or push between SHA-1 and SHA-256 repositories. Export/import retains files, authors, dates, messages, and graph structure, but all converted commit hashes change.

**How to apply:** Get explicit approval for changed commit hashes. Verify source and converted commit counts, merge any existing remote initialization commit without force, push from the temporary SHA-256 repository, and verify the remote head. Keep the original workspace unchanged.