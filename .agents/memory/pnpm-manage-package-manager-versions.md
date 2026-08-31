---
name: pnpm auto package-manager version management breaks all workflows
description: pnpm 10's manage-package-manager-versions feature can make every pnpm invocation fail with EAGAIN/SIGABRT; fix is an .npmrc flag, not a workspace/code bug.
---

When package.json pins `"packageManager": "pnpm@<older-version>"` but the environment's active `pnpm` binary is a newer major (e.g. workspace pins pnpm@9.15.9, environment ships pnpm@10.x), pnpm 10 tries to self-install and re-exec the pinned version on almost every invocation (`pnpm add pnpm@<pinned> --allow-build=@pnpm/exe ...`). That self-install can fail with `spawnSync pnpm EAGAIN` or `SIGABRT`, and then **every** pnpm command fails the same way — including plain `pnpm --version`, `pnpm config list`, and every dev-server/build/test workflow that shells out to pnpm.

Symptoms: several unrelated workflows fail simultaneously with `EAGAIN`/`SIGABRT` on a `pnpm add pnpm@X.Y.Z ...` line, or workflows that previously failed with `EADDRINUSE`/"port already in use" (because a prior stuck attempt left the process straddling the same port) now fail this new way after a retry. `ss`/`netstat` may not exist in this environment — use `lsof -i tcp:<port>` instead to check for stale listeners.

**Fix:** add `manage-package-manager-versions=false` to the workspace root `.npmrc`. This stops pnpm from trying to auto-switch versions on every call; it then just runs the installed binary directly. No workflow/config changes needed beyond this.

**Why:** this is a pnpm-level auto-provisioning feature interacting badly with the Replit Nix-provided pnpm binary version, not a code or dependency bug — restarting the affected workflows repeatedly does not fix it and wastes time; the `.npmrc` flag does.
