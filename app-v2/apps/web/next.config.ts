import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sql.js touches the filesystem to load its wasm binary — that only works
  // with a native `require`, not the bundled Server Components graph.
  serverExternalPackages: ["sql.js"],
  // This app lives inside a monorepo that itself sits inside a SIBLING repo
  // (/home/user/wacrm) with its own lockfile and its own unrelated Next.js
  // app under src/. Without an explicit root, Next's lockfile-based
  // workspace-root inference picks that outer directory and pulls the
  // sibling app's files (e.g. its middleware.ts) into this build. Pin the
  // root to this monorepo instead.
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

export default nextConfig;
