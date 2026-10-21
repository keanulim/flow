import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-only "N" button would sit on top of the AI chat button (bottom right).
  // Error overlays still appear when something breaks.
  devIndicators: false,
  // A separate build folder when asked (e.g. testing a production build while the dev server runs).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The demo's sample notes and chats (demo/) are read at runtime when a
  // visitor's sandbox is created, so they must ship with the server code.
  outputFileTracingIncludes: { "/api/**/*": ["./demo/**/*"] },
};

export default nextConfig;
