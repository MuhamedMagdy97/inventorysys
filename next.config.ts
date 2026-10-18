import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Doc 26 security headers. The CSP needs a per-request nonce, so src/proxy.ts sets it.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
  // Browsers only honour HSTS over HTTPS, so it's harmless on a local `next start`.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "standalone", // T10.4: minimal server bundle for the Docker image
  poweredByHeader: false,
  experimental: {
    // Evidence uploads (≤ 10 MB per file, doc 26) and imports (≤ 5 MB, flow 20) + multipart overhead.
    serverActions: { bodySizeLimit: "11mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
