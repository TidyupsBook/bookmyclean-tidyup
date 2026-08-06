// Standalone Vitest config: vite.config.ts requires PORT (dev-server only),
// so tests deliberately do not load it.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
