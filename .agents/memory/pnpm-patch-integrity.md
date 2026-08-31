---
name: Pnpm patch integrity
description: How to make local pnpm dependency patches reliably materialize.
---

Generate a local package patch with `pnpm patch` followed by `pnpm patch-commit`; do not hand-author its final diff. After changing a patched dependency, force a fresh install and inspect the copy actually resolved by the consuming package. A stale virtual-store patch can differ from the tracked patch file, so regenerate the patch after an intentional workspace edit rather than trusting its existing hash.

**Why:** A malformed patch can still produce patch metadata in the lockfile while pnpm leaves the installed package unmodified, so the intended security guard is absent at runtime.

**How to apply:** Use pnpm's patch workspace to make or preserve the source changes, commit it through pnpm, then run `pnpm install --force --frozen-lockfile`; verify both the lockfile patch hash and the relevant installed files after that clean install.

For `image-size` specifically, Metro gives its asset sizer a file path. The path-to-bytes compatibility guard must run before format detection, and it must live in the same regenerated patch as the malformed-image loop guards. A production-like Metro bundle request is the final proof; a unit test that imports a stale virtual-store copy is not enough.