/**
 * Vite config for the badge e2e test.
 *
 * Identical to the main vite.config.ts except:
 *  - @clerk/react  → e2e/clerk-mock.tsx     (always signed-in, no CDN)
 *  - @clerk/react/internal → e2e/clerk-mock-internal.ts
 *  - @clerk/themes → e2e/clerk-themes-mock.ts
 *  - Replit-specific plugins are omitted (not needed for headless CI)
 */
import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rawPort = process.env.PORT;
if (!rawPort) throw new Error("PORT is required");
const port = Number(rawPort);

const basePath = process.env.BASE_PATH;
if (!basePath) throw new Error("BASE_PATH is required");

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Replace the real Clerk SDK with a minimal always-signed-in mock.
      "@clerk/react/internal": path.resolve(
        import.meta.dirname,
        "clerk-mock-internal.ts",
      ),
      "@clerk/react": path.resolve(import.meta.dirname, "clerk-mock.tsx"),
      "@clerk/themes": path.resolve(
        import.meta.dirname,
        "clerk-themes-mock.ts",
      ),
      // Keep the standard source aliases from the main config.
      "@": path.resolve(import.meta.dirname, "../src"),
      "@assets": path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "attached_assets",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname, ".."),
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: { strict: true },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
