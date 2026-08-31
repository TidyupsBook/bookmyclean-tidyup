---
name: Deployment log visibility
description: fetchDeploymentLogs is scoped to the current deployment build; republishing hides earlier logs.
---
fetchDeploymentLogs returns nothing for time windows before the currently-promoted build started, even though those logs existed (verified: pre-publish request logs seen via RefreshAllLogs drains were absent from a later fetchDeploymentLogs query over the same window).

**Why:** logs are scoped per deployment revision; publishing promotes a new revision.

**How to apply:** when investigating a production incident, fetch and save deployment logs BEFORE any republish; after a republish, rely on previously drained /tmp/logs deployment files for pre-publish history. Also: uptime-monitor outages that align with "starting up user application" timestamps are publish transitions, not crashes.
