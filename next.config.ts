import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["ai-sdk-app.dev", "*.ai-sdk-app.dev"],
  devIndicators: false,
};

export default nextConfig;
