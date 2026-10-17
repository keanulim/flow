import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-only "N" button would sit on top of the AI chat button (bottom right).
  // Error overlays still appear when something breaks.
  devIndicators: false,
};

export default nextConfig;
