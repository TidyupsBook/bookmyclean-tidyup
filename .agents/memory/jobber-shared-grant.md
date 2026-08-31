---
name: Jobber shared grant across environments
description: Why background Jobber polling is production-only and how refresh rejections should be read
---
Dev and the published site share one Jobber account, and Jobber rotates the refresh token on every renewal. Two environments both refreshing in the background take turns invalidating each other's grant — the second refresher gets a 401 and flags the company for reconnect.

**Why:** Observed in prod logs Aug 2026: running dev silently knocked the live site off Jobber; owner had to keep reconnecting.

**How to apply:** Background Jobber polling must stay gated on the PUBLIC_APP_URL pin (production only); dev syncs on demand. Any refresh-rejection copy/log should name the environment, because the *other* copy is usually still connected. New background consumers of the Jobber grant need the same gate.
