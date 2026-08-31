---
name: Dashboard browser fixtures
description: First-visit browser prompts can intercept dashboard interactions in end-to-end tests.
---

Dashboard end-to-end fixtures should pre-answer device and notification permission asks in browser storage before mounting the app.

**Why:** The dashboard mounts those prompts globally on authenticated pages, so an otherwise unrelated dialog can intercept clicks on the page under test.

**How to apply:** Seed the exact storage keys used by the permission components, then assert the business flow rather than relying on Escape to dismiss whichever prompt appeared first.