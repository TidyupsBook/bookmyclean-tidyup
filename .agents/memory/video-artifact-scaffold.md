---
name: video-js artifact scaffold gaps
description: A new video-js artifact turns repo-wide CI red on its own generated files, for reasons invisible in the preview.
---

# video-js scaffold gaps

Creating a `video-js` artifact breaks the repo's `typecheck` and `format` workflows on
files nobody wrote by hand — the scaffold's own output. Both need fixing in the same
pass as the video build.

- **Typecheck**: the generated tsconfig omits the DOM libs, so the scaffold's own video
  hook fails on `window` / `document`. Match the `lib` entry the web artifacts already use.
- **Format**: the generated files are not prettier-clean.

**Why:** the artifact's Vite dev server transpiles without typechecking, so the video
plays perfectly in the preview while CI is red. Judging the build by the preview alone
hides both problems.

**How to apply:** fix the tsconfig as soon as the artifact is created; run prettier over
the artifact directory only *after* the design subagent finishes, since it rewrites those
files.
