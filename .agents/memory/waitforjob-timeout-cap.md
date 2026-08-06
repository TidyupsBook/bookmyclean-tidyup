---
name: waitForJob timeout is capped
description: The timeout argument to waitForJob is silently clamped far below what you pass, so it cannot be used to block on a long-running subagent.
---

# waitForJob's timeout is silently clamped

Passing `waitForJob({ jobId, timeout: 900 })` does **not** wait 900 seconds. The call
returns in roughly 20 seconds. Chaining several of them looks like a long wait in the
transcript while almost no wall-clock time has passed.

**Why this matters:** it is invisible. Each call comes back "still running", which reads
exactly like a genuine long wait. It is easy to burn a dozen calls believing hours have
elapsed when it has been three minutes, and then wrongly conclude a subagent is hung.

**How to apply:** when waiting on something genuinely long (a design subagent building a
video, a big install), do not raise the `timeout` number. Instead:

- Check real elapsed time with `date` before assuming a job is stuck.
- Burn real wall time with a shell `sleep` (the shell tool allows up to ~300s per call),
  then re-check the job.
- Confirm progress out-of-band by looking at file mtimes in the directory the job writes
  to, rather than trusting the job status alone.
