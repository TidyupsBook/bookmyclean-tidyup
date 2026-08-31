---
name: Canonical redirect vs infrastructure probes
description: Why the canonical-host 301 must exempt /api/healthz and how the restart-loop failure presented
---

Rule: any middleware that 301s non-canonical hosts to the pinned domain must exempt infrastructure probe paths (`/api/healthz`) alongside webhook receivers and OAuth callbacks.

**Why:** The deployment health checker probes `GET /api/healthz` with `Host: localhost`. When the canonical pin (PUBLIC_APP_URL) went live, the checker got a 301, followed it out to the public domain, hairpinned into the still-starting deployment, and timed out ("context deadline exceeded") — so the platform SIGTERM-restarted every artifact process, all day. The symptoms looked unrelated to the cause: the mobile app "wouldn't load" (its bundle server kept dying mid-download) and auto-answered calls went missing (Quo webhook POSTs landed on a restarting server), while the website "worked" because the SPA is served by the platform's static handler, which never restarts.

**How to apply:** the exempt list is `canonicalHostRedirect([...])` in the API server's app setup; `HEALTHZ_PATH` is exported by the health route. Any new probe or third-party callback path must be added there AND to the EXEMPT array in the canonicalHost test. Diagnosis shortcut: deployment logs showing `healthcheck failed` interleaved with the app answering 301 on the probe path = this bug; check that before touching anything else.
