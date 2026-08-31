---
name: pnpm overrides need bounded ranges
description: Unscoped security overrides (open >= bounds or bare pins) force wrong majors onto consumers; the break surfaces far from the diff (iOS build, Metro bundling, deploys)
---

A root `pnpm.overrides` entry written as a single open-ended bound (`"pkg": ">=5.0.9"`,
the shape a vulnerability report suggests) applies to **every** consumer in the
monorepo, including transitive dependencies that were pinned to an older major on
purpose. When the fixed version is also the one that moved to ESM-only named exports,
every CJS `require()` of it breaks.

**Why:** a CVE pin on a string-expansion helper pushed an ESM-only major under an old
glob dependency inside React Native's codegen. Local dev, tests, typecheck and the web
build were all green — only the iOS dependency-install step failed, with a bare
`TypeError: <import> is not a function` and no mention of the override.

A version that does not exist is the same trap wearing a different hat: an override
pinned to a patch nobody published resolves *upward* to the next real release, which
can be an ESM-only major. That killed API codegen outright — the generator pins an
older major and imports it as a CJS default, so it died at import with nothing to
suggest an override was involved.

`image-size` is an exception that proves the rule: Metro declares `^1.0.2` and passes
a file *path* to `imageSize()`, but 2.x accepts only byte buffers. A bare
`"image-size": "2.0.2"` therefore broke Expo bundling deep in asset sizing despite
green unit tests and typechecks. The safe resolution is now a local 2.x patch that
retains Metro's Node path input and protects the malformed-image parser loops; keep
the regression that bundles all Expo platforms and sizes a PNG by path.

The escape hatch for one broken consumer is a dependent-scoped override,
`"parent>child": "<exact version>"`, which leaves the blanket entry in place for
everyone else.

Also expect the lockfile regen to normalize unrelated entries (peer-dep contexts,
`optional:` flags) when overrides change — resolution is invalidated wholesale.
Don't hand-trim the lockfile; re-run the repo gates against the final lockfile with
the same pnpm major the deploy uses instead.

**How to apply:** write overrides as one entry per major with a *bounded* range
(`pkg@1: ^1.1.12`, `pkg@2: ^2.0.2`, …), each still at or above the advisory version.
Selectors with an open `>=` bound resolve straight back to the newest major and
silently undo the fix — confirm with `pnpm why` rather than assuming the selector
took. Any override touching a package that a native toolchain pulls in should be
checked with a prebuild, not just the repo test suite. For image-size specifically,
do not reintroduce a 1.x exception: regenerate and verify the tracked 2.x patch after
changing it.
