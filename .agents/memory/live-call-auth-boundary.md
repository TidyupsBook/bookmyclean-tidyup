---
name: Live call auth boundary
description: Security rule for clearing app-wide live-call state when the authenticated identity changes.
---

# Live call state is owned by the authenticated identity

The capture provider must receive the stable auth identity even though it is
mounted above the router. Any transition between resolved identities,
including a transition to signed out, must stop recognition, invalidate pending
starts, clear the transcript, and drop the followed call claim before the next
identity can render.

**Why:** route-level watchers can unmount during sign-out, and an owner-to-owner
switch can leave both users entitled to live calls. A role-only guard therefore
cannot protect the long-lived microphone state or the words it holds.

**How to apply:** keep the identity boundary at the provider's auth-aware
mount, use a loading sentinel so the initial auth resolution is not mistaken
for a switch, and treat any later resolved identity change as a destructive
reset of capture-only state.