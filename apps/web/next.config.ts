import type { NextConfig } from "next";

/** BASHT HQ is off unless the build enables it; see lib/hq/flag.ts. */
const HQ_ENABLED = process.env.NEXT_PUBLIC_HQ_ENABLED === "1";
const DEV = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy (security review L3), enforced. Everything comes from this origin: no third-party script, frame,
 * connection or font. Scripts: 'self' plus 'unsafe-inline' because Next's App Router streams its payload in inline <script> tags
 * and the pages are statically rendered (a nonce would force every page dynamic); no 'unsafe-eval' in production.
 * 'wasm-unsafe-eval' lets the HQ decode its KTX2 textures (compiling WebAssembly only, never JS eval).
 * Inline styles: React's server-rendered style attributes. data:/blob: images and media: screenshots, local files, voice audio.
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${DEV ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${DEV ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "frame-src 'self' blob:", // the PDF preview of a local file
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The app has no image needs beyond its own static icons (plain <img>): the optimizer endpoint (/_next/image, public and behind
  // several past advisories, review H1) stays switched off.
  images: { unoptimized: true },
  // With the HQ off, /hq must not serve the page (its notFound() is streamed with status 200): send the visitor home.
  // A redirect, never a proxy to another server (pinned by services/api/tests/test_deploy_topology.py).
  async redirects() {
    // One conversation (U1): BASHT text, archive and voice all live in /chat. The old addresses keep working.
    const unified = [
      { source: "/chat/basht", destination: "/chat", permanent: false },
      { source: "/calls", destination: "/chat?voice=1", permanent: false },
    ];
    return HQ_ENABLED ? unified : [...unified, { source: "/hq/:path*", destination: "/", permanent: false }];
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
          { key: "Content-Security-Policy", value: CSP },
          // HTTPS only from now on (browsers ignore this header on plain-http responses, so local dev is unaffected)
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
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
