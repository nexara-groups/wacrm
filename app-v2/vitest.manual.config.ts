import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * TEMPORARY, not part of the deliverable — used only to invoke the webhook
 * route handlers directly (bypassing `proxy.ts`, which blocks
 * `/api/webhooks/**` at the edge; see the delivery report) for a real,
 * unmocked capture of GET/POST behavior. Deleted after use.
 */
export default defineConfig({
  test: { globals: true, environment: "node", include: ["**/*.manual.test.ts"] },
  resolve: {
    alias: {
      "@nexara": fileURLToPath(new URL("./nexara", import.meta.url)),
      "@modules": fileURLToPath(new URL("./modules", import.meta.url)),
      "@packages": fileURLToPath(new URL("./packages", import.meta.url)),
      "@shared": fileURLToPath(new URL("./nexara/shared", import.meta.url)),
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
    },
  },
});
