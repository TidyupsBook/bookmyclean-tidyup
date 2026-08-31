// Standalone Vitest config for the Expo app. Metro (not Vite) serves the real
// app, so this config exists only for tests: it maps react-native to
// react-native-web so component tests can render in jsdom.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests bypass Metro's babel preset, so the automatic JSX runtime must be
  // set explicitly or JSX fails with "React is not defined".
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "react-native": "react-native-web",
      "@": path.resolve(import.meta.dirname),
    },
  },
  test: {
    // Component tests (.tsx) opt into jsdom via a @vitest-environment pragma;
    // plain .ts tests stay in node.
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "static-build/**"],
    maxWorkers: 4,
  },
});
