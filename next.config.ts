import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Import uploads (flow 20) are capped at 5 MB in the domain; leave room for multipart overhead.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
