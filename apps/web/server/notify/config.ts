/**
 * Notification-server configuration. Everything comes from the environment and FAILS CLOSED:
 * without valid VAPID keys push is "unconfigured" and the API says so — nothing is faked.
 */
export type Env = Record<string, string | undefined>;
export type NotifyConfig = {
  push: { publicKey: string; privateKey: string; subject: string } | null;
  databaseUrl: string | null;
  /** memory store only outside production, or when explicitly allowed (single instance, state lost on restart) */
  allowMemory: boolean;
  dispatchSecret: string | null;
  loop: boolean;
  tickMs: number;
  maxDevices: number;
  /** extra hosts accepted as push endpoints (tests / self-hosted push); loopback only outside production */
  extraEndpointHosts: string[];
  production: boolean;
};

const B64URL = /^[A-Za-z0-9_-]+$/;
export function readNotifyConfig(env: Env = process.env): NotifyConfig {
  const pub = env.VAPID_PUBLIC_KEY?.trim(), priv = env.VAPID_PRIVATE_KEY?.trim(), subject = env.VAPID_SUBJECT?.trim();
  const validSubject = !!subject && (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject) || /^https:\/\/[^\s/]+/.test(subject));
  const validKeys = !!pub && !!priv && B64URL.test(pub) && B64URL.test(priv) && pub.length === 87 && priv.length === 43;
  const production = env.NODE_ENV === "production";
  const num = (v: string | undefined, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : d; };
  return {
    push: validKeys && validSubject ? { publicKey: pub!, privateKey: priv!, subject: subject! } : null,
    databaseUrl: env.NOTIFY_DATABASE_URL?.trim() || null,
    allowMemory: !production || env.NOTIFY_ALLOW_MEMORY === "1",
    dispatchSecret: env.NOTIFY_DISPATCH_SECRET && env.NOTIFY_DISPATCH_SECRET.length >= 24 ? env.NOTIFY_DISPATCH_SECRET : null,
    loop: env.NOTIFY_DISPATCH_LOOP !== "0",
    tickMs: num(env.NOTIFY_TICK_MS, 20_000, 1_000, 300_000),
    maxDevices: num(env.NOTIFY_MAX_DEVICES, 5_000, 1, 1_000_000),
    extraEndpointHosts: (env.NOTIFY_EXTRA_ENDPOINT_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    production,
  };
}
