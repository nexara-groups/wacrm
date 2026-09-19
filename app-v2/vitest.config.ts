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
    },
  },
});
