---
name: Speech diagnostics privacy
description: Device speech troubleshooting state must identify stages without recording customer call content.
---

Speech smoke diagnostics may expose platform, permission outcome, recognizer error code, and the last processing stage, but must never include transcript text in normal production logs or diagnostic summaries.

**Why:** Owners need actionable failure classification without turning troubleshooting output into a second copy of sensitive customer call content.

CI summaries must accept only closed, known-safe values for every diagnostic field, not merely allowlisted field names. Post-failure summary and artifact steps must each use `always()` so one reporting failure cannot suppress the others.

**Why:** Free-form text can be hidden inside an approved JSON field, and GitHub Actions implicitly adds `success()` to conditions without a status function.

**How to apply:** Keep diagnostic state separate from transcript state, validate every summary value against the installed recognizer vocabulary, and independently guard each failure-reporting step.