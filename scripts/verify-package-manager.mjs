import { rmSync } from "node:fs";

if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}

const root = new URL("../", import.meta.url);
rmSync(new URL("package-lock.json", root), { force: true });
rmSync(new URL("yarn.lock", root), { force: true });
