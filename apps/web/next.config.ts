import type { NextConfig } from "next";

// Legacy, local development only: `API_PROXY_URL=http://127.0.0.1:8000 pnpm dev:web` proxies /backend/* to the API.
// The UI no longer uses it: it talks to the API through the server-side BFF `/api/health` (needs BACKEND_URL).
// Unset in production, where routing is handled by the platform configuration.
const proxy = process.env.API_PROXY_URL;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return proxy ? [{ source: "/backend/:path*", destination: `${proxy.replace(/\/$/, "")}/:path*` }] : [];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" },
      ],
    }];
  },
};
export default nextConfig;
