/**
 * What the BASHT engine says about itself (its GET /app/v1/status), reduced to ONE fixed, validated shape.
 *
 * The same parser runs in the BFF (server/basht-chat.ts: nothing unexpected is ever relayed) and in the browser (a second pair of
 * eyes). Every field is optional on the engine side (an older engine has none of the new ones): anything missing, mistyped,
 * out of range or not on an allow-list is DROPPED, never repaired and never guessed, so "no data" stays "no data" (`unknown`).
 * Nothing here can carry an account id, a path, a hostname, a log line or an error text: only fixed tokens, short ids and counts.
 */
export const VOICE_SPEAK = ["ready", "degraded", "unconfigured", "mismatch", "unknown"] as const;
export type VoiceSpeak = (typeof VOICE_SPEAK)[number];
/** `link.state` of the engine's persistent gateway link (src/gateway-link.js). */
export const LINK_STATES = ["off", "connecting", "up", "down"] as const;
export type LinkState = (typeof LINK_STATES)[number] | "unknown";
export const SIGNING_MODES = ["off", "optional", "required"] as const;
export type SigningMode = (typeof SIGNING_MODES)[number] | "unknown";
/** Capability ids the app knows; any other id is dropped (the app cannot act on it, and free text must not travel). */
export const KNOWN_FEATURES = ["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1",
  "history.images.v1", "media.inline.v1", "media.guard.v1", "runs.runId.v1", "errorCode.rate_limited.v1"] as const;
export const ATTACHMENT_KEYS = ["maxImages", "maxImageBytes", "maxTotalImageBytes", "maxFileBytes", "maxInlineBytes"] as const;
export type AttachmentKey = (typeof ATTACHMENT_KEYS)[number];
/** Spoken-voice failure tokens (the shared voice contract; lib/basht-client.ts VOICE_REASONS must equal this list, a test checks it). */
export const ENGINE_VOICE_REASONS = ["identity_mismatch", "tool_denied", "unconfigured", "provider_error", "link_down", "timeout", "bad_audio", "engine_error",
  "in_flight", "per_minute", "text_rejected", "tool_path_only", "tool_path_unavailable", "no_tts_config", "config_unreadable"] as const;

/** Upper bounds: a count or a byte limit above these is not a limit this engine would send; it is dropped. */
export const MAX_COUNT = 1_000_000;
export const MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const MAX_COUNT_ATTACH = 1000;

export type EngineRuns = { active: number | null; total: number | null; approvalsPending: number | null; complete: boolean };
/** An answer older than this is not an answer this stack would give (the API caches for 30 s): its age is treated as unknown. */
export const MAX_AGE_MS = 10 * 60 * 1000;

export type EngineStatus = {
  /**
   * How long ago the engine REALLY answered, when the API says so (0 = read just now; a cache hit says how old the cached answer is).
   * null = unknown (an older API): such an answer is never evidence that beats a newer real event. An age, not a timestamp, so the
   * phone's clock and the server's never have to agree.
   */
  ageMs: number | null;
  /** The engine's /status answered through the signed bridge. false = no answer (or none validated): everything else is empty. */
  reachable: boolean;
  /** Engine (OpenClaw) version, 1-32 characters of [A-Za-z0-9._+-]; null when absent. */
  version: string | null;
  /** The wrapper build commit (7-12 lowercase hex); null when absent. */
  commit: string | null;
  features: string[];
  attachments: Partial<Record<AttachmentKey, number>>;
  link: { state: LinkState; pendingApprovals: number | null };
  voice: { speak: VoiceSpeak; reason?: (typeof ENGINE_VOICE_REASONS)[number] };
  runs: EngineRuns | null;
  signing: { mode: SigningMode; active: boolean | null };
};

export const UNKNOWN_ENGINE_STATUS: EngineStatus = {
  reachable: false, ageMs: null, version: null, commit: null, features: [], attachments: {},
  link: { state: "unknown", pendingApprovals: null }, voice: { speak: "unknown" }, runs: null, signing: { mode: "unknown", active: null },
};
export const unknownEngineStatus = (): EngineStatus => ({ ...UNKNOWN_ENGINE_STATUS, attachments: {}, features: [], link: { ...UNKNOWN_ENGINE_STATUS.link }, voice: { speak: "unknown" }, signing: { ...UNKNOWN_ENGINE_STATUS.signing } });

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A non-negative safe integer within `max`; anything else (a string, a float, NaN, a negative, a boolean) is null. */
export const boundedInt = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const COMMIT_RE = /^[0-9a-f]{7,12}$/;

/**
 * Anything → the one fixed shape. `reachable` is true only when the answer is an object that says `ok !== false`; a non-object is
 * `UNKNOWN_ENGINE_STATUS`. Each field is validated on its own: one bad field never discards the others, and never turns into a value.
 */
export function parseEngineStatus(j: unknown): EngineStatus {
  const o = obj(j);
  if (!o || o.ok === false) return unknownEngineStatus();
  const out = unknownEngineStatus();
  out.reachable = true;
  out.ageMs = boundedInt(o.ageMs, MAX_AGE_MS);

  const eng = obj(o.engine);
  if (eng && typeof eng.version === "string" && VERSION_RE.test(eng.version)) out.version = eng.version;
  const wr = obj(o.wrapper);
  if (wr && typeof wr.commit === "string" && COMMIT_RE.test(wr.commit)) out.commit = wr.commit;

  if (Array.isArray(o.features)) {
    const have = new Set(o.features.slice(0, 64).filter((f): f is string => typeof f === "string" && f.length <= 40));
    out.features = KNOWN_FEATURES.filter((f) => have.has(f));
  }

  const att = obj(o.attachments);
  if (att) {
    for (const k of ATTACHMENT_KEYS) {
      const v = boundedInt(att[k], k === "maxImages" ? MAX_COUNT_ATTACH : MAX_BYTES);
      if (v !== null) out.attachments[k] = v;
    }
  }

  const link = obj(o.link);
  if (link) {
    out.link = { state: oneOf(LINK_STATES, link.state) ?? "unknown", pendingApprovals: boundedInt(link.pendingApprovals, MAX_COUNT) };
  }

  const voice = obj(o.voice);
  const speak = voice ? oneOf(VOICE_SPEAK, voice.speak) : null;
  if (voice && speak) {
    const reason = oneOf(ENGINE_VOICE_REASONS, voice.reason);
    out.voice = { speak, ...(reason ? { reason } : {}) };
  }

  const runs = obj(o.runs);
  if (runs) {
    out.runs = { active: boundedInt(runs.active, MAX_COUNT), total: boundedInt(runs.total, MAX_COUNT), approvalsPending: boundedInt(runs.approvalsPending, MAX_COUNT), complete: runs.complete === true };
  }

  const sg = obj(o.signing);
  if (sg) out.signing = { mode: oneOf(SIGNING_MODES, sg.mode) ?? "unknown", active: typeof sg.active === "boolean" ? sg.active : null };
  return out;
}

/** `{reachable:false}` is also the BFF's answer when the engine cannot be read; this tells "answered" from "not answered". */
export const engineAnswered = (s: EngineStatus | null | undefined): s is EngineStatus => !!s && s.reachable;

/**
 * EngineStatus → the engine's own (filtered) wire shape, which `parseEngineStatus` reads back. This is what the BFF sends the browser,
 * so the API, the BFF and the browser all speak the engine's field names. Not reachable = `{ ok: false }`.
 */
export function engineStatusWire(s: EngineStatus): Record<string, unknown> {
  if (!s.reachable) return { ok: false };
  return {
    ok: true,
    ...(s.ageMs !== null ? { ageMs: s.ageMs } : {}),
    ...(s.version ? { engine: { version: s.version } } : {}),
    wrapper: { commit: s.commit },
    features: s.features,
    attachments: s.attachments,
    ...(s.link.state !== "unknown" || s.link.pendingApprovals !== null ? { link: { ...(s.link.state !== "unknown" ? { state: s.link.state } : {}), ...(s.link.pendingApprovals !== null ? { pendingApprovals: s.link.pendingApprovals } : {}) } } : {}),
    ...(s.voice.speak !== "unknown" ? { voice: s.voice } : {}),
    ...(s.runs ? { runs: { active: s.runs.active, total: s.runs.total, approvalsPending: s.runs.approvalsPending, complete: s.runs.complete } } : {}),
    ...(s.signing.mode !== "unknown" || s.signing.active !== null ? { signing: { ...(s.signing.mode !== "unknown" ? { mode: s.signing.mode } : {}), ...(s.signing.active !== null ? { active: s.signing.active } : {}) } } : {}),
  };
}
