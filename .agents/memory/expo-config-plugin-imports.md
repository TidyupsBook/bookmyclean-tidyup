---
name: Expo config-plugin imports
description: Prevent Expo Launch config resolution from depending on pnpm's local transitive package layout
---

Local Expo config plugins must import configuration helpers from
`expo/config-plugins`, rather than directly importing `@expo/config-plugins`
unless the latter is explicitly declared by the artifact.

**Why:** A pnpm development command can incidentally resolve Expo's transitive
implementation package, while Expo Launch invokes its own CLI in a clean build
environment. The undeclared import then makes `expo config --json` fail before
credentials or native compilation begin.

**How to apply:** Treat `expo/config-plugins` as the supported entry point for
project-owned config plugins and validate it by resolving the config through
the direct Expo CLI, not only through `pnpm exec expo`.