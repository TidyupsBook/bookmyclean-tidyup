---
name: Orval zod v4 mismatch
description: Generated zod schemas use zod v4 API while workspace resolves zod 3.25
---
Orval v8 emits zod v4 calls like `zod.int()`, but the workspace catalog pins zod ^3.25 (which ships the v4 API only under the `zod/v4` subpath).

**Why:** typecheck failed with `Property 'int' does not exist` on the generated `lib/api-zod/src/generated/api.ts`.

**How to apply:** the `@workspace/api-spec` codegen script already seds the generated file's import to `from 'zod/v4'`. Keep that step if the script is edited; don't hand-edit generated files.
