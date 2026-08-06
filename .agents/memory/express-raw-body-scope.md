---
name: Scope express.raw to the exact webhook path
description: Mounting a raw body parser on a shared prefix silently breaks JSON parsing for every other route under it.
---

# Scope express.raw to the exact webhook path

Webhook signature verification needs the raw request bytes, so the raw parser must run
before `express.json()`. Mount it on the **exact webhook path**, never on a shared
prefix like `/api`.

**Why:** body-parser sets `req._body = true` once any parser consumes the request, and
every later parser skips a request already marked that way. A raw parser mounted on
`/api` therefore leaves `req.body` as a `Buffer` for *all* `/api` routes — every JSON
endpoint under it breaks at once, and the failure looks like malformed client input
rather than a middleware ordering bug.

**How to apply:**

```ts
app.use("/api/webhooks/<provider>", express.raw({ type: "application/json" }));
app.use("/api", webhookRouter); // matches only its own route, calls next() otherwise
app.use(express.json());        // still parses every other /api route
```

Export the path constant from the router module so the mount point and the route
definition cannot drift apart.
