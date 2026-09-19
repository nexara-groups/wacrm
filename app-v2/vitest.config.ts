import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    // `*.manual.test.ts` files are scaffolding: throwaway harnesses for
    // driving a route handler by hand during development, each with its own
    // config (vitest.manual.config.ts). They are NOT part of the suite, but
    // `**/*.test.ts` matches them, so without this exclusion a piece of
    // scratch work turns the whole suite red and the real signal is lost in
    // it. Opting in explicitly is the point of giving them a separate config.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.manual.test.ts"],
  },
  resolve: {
    alias: {
      "@nexara": fileURLToPath(new URL("./nexara", import.meta.url)),
      "@modules": fileURLToPath(new URL("./modules", import.meta.url)),
      "@packages": fileURLToPath(new URL("./packages", import.meta.url)),
      "@shared": fileURLToPath(new URL("./nexara/shared", import.meta.url)),
    },
  },
});
