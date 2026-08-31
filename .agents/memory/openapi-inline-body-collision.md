---
name: Inline request bodies break codegen
description: Why every OpenAPI requestBody must be a named component schema in this repo
---

Every `requestBody` in `openapi.yaml` must `$ref` a named component schema.
Never write an inline `type: object` body.

**Why:** the zod generator emits a const named after the operation
(`SendClientMessageBody`) *and* a TypeScript type with the identical name for
an inline body. Both are re-exported from the same package index, so the build
dies with TS2308 "has already exported a member named …". A `$ref`'d component
names the type after the schema instead, so the two never collide. The failure
appears at the codegen step, far from the yaml edit that caused it.

**How to apply:** when adding a POST/PATCH endpoint, add its input as a
component schema (e.g. `SendMessageInput`) and reference it from the path.
