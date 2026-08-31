---
name: Speech diagnostics privacy
description: Device speech troubleshooting state must identify stages without recording customer call content.
---

Speech smoke diagnostics may expose platform, permission outcome, recognizer error code, and the last processing stage, but must never include transcript text in normal production logs or diagnostic summaries.

**Why:** Owners need actionable failure classification without turning troubleshooting output into a second copy of sensitive customer call content.

**How to apply:** Keep diagnostic state separate from transcript state and use corrective-action copy for microphone, recognizer, and extraction failures.