import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    // Evidence uploads (≤ 10 MB per file, doc 26) and imports (≤ 5 MB, flow 20) + multipart overhead.
    serverActions: { bodySizeLimit: "11mb" },
  },
};

export default nextConfig;
