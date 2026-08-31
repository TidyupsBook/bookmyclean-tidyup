---
name: OpenAPI component naming vs orval
description: Component schema names must not collide with orval's generated <OperationId>Response names
---

Rule: never name an OpenAPI component schema `<OperationId>Response` for an operation named `<operationId>`.

**Why:** the generated zod client also emits an export with that exact name, and the barrel re-export makes typecheck fail with an ambiguity error.

**How to apply:** suffix response components `Result` (or any non-`Response` name).
