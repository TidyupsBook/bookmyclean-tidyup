// Standalone Vitest config: vite.config.ts requires PORT (dev-server only),
// so tests deliberately do not load it.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The dev server gets this from the React plugin; tests skip the plugin so
  // the automatic JSX runtime must be set explicitly.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // Component tests (.tsx) opt into jsdom via a @vitest-environment pragma.
    include: ["src/**/*.test.{ts,tsx}"],
    // Validation runs every workspace's checks at once; an uncapped forks
    // pool has died there with pthread_create EAGAIN. Four workers keeps the
    // suite fast without gambling on the box having threads to spare.
    maxWorkers: 4,
  },
});
