---
name: Pnpm audits with unpatched upstream CVEs
description: How to keep pnpm audits accurate when a locally patched package has no upstream fixed release.
---

Place an audit exclusion in `pnpm-workspace.yaml`, rather than nesting it in
the root package manifest. Keep both the legacy `auditConfig.ignoreCves` list
and the current `audit.ignore` GHSA list while the project may be validated
with either pnpm 10 or pnpm 11.

**Why:** pnpm 10 uses CVE identifiers for audit exclusions, while newer pnpm
uses GHSA identifiers. A locally patched package can be secure even when the
registry has not released a version outside an advisory's affected range.

**How to apply:** First remove any unused direct dependency. For an unavoidable
transitive dependency, retain the version-pinned local patch and its matching
test coverage, then add the relevant IDs to the workspace audit configuration.