import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { globals: true, environment: "node", include: ["**/*.test.ts"] },
  resolve: {
    alias: {
      "@nexara": fileURLToPath(new URL("./nexara", import.meta.url)),
      "@modules": fileURLToPath(new URL("./modules", import.meta.url)),
      "@packages": fileURLToPath(new URL("./packages", import.meta.url)),
      "@shared": fileURLToPath(new URL("./nexara/shared", import.meta.url)),
      // Matches apps/web/tsconfig.json's own "@/*" -> "./*" path mapping.
      // Its absence is why no route under apps/web/app/api had a test: any
      // route importing "@/lib/..." — which every one of them does — failed
      // to resolve here, so route-level tests were quietly impossible and the
      // gap read as a convention rather than a missing alias.
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
    },
  },
});
