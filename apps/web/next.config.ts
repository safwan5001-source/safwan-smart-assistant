import type { NextConfig } from "next";

/** BASHT HQ is off unless the build enables it; see lib/hq/flag.ts. */
const HQ_ENABLED = process.env.NEXT_PUBLIC_HQ_ENABLED === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // With the HQ off, /hq must not serve the page (its notFound() is streamed with status 200): send the visitor home.
  // A redirect, never a proxy to another server (pinned by services/api/tests/test_deploy_topology.py).
  async redirects() {
    return HQ_ENABLED ? [] : [{ source: "/hq/:path*", destination: "/", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" },
        ],
      },
      // HQ 3D assets carry a content version in their path (public/hq/<version>/…), so they can be cached forever.
      { source: "/hq-assets/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // BFF responses are per-request and may relate to a session: never cacheable by browsers or shared caches.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};
export default nextConfig;
