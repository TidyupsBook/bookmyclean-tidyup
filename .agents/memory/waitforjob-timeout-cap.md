---
name: waitForJob timeout behavior
description: How long waitForJob actually waits, and how to handle long-running subagent jobs
---

# waitForJob timeout behavior

The `timeout` argument (seconds) is honored for long waits — observed a full 300s wait on a default call and a successful 280s wait that returned a finished architect review. An earlier session concluded it was clamped to ~20s; that is outdated (platform behavior changed or the original diagnosis was wrong).

**How to apply:** for long-running jobs (architect reviews, testing agents), await the job or call `waitForJob({ jobId, timeout: ~280 })` in a small retry loop — 2-3 rounds covers most reviews. If a wait times out, the job is usually still running: re-call `waitForJob` with the same jobId rather than restarting the subagent. When the job finished during a timed-out wait, the next `waitForJob` returns instantly with the result.
