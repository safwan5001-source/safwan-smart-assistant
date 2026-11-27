/**
 * Browser-side client for /api/auth/* (A1): one sign-in for the whole app — the owner code or Face ID (a passkey).
 * The session lives in an HttpOnly cookie this code never sees. Failures become Arabic messages; nothing upstream leaks.
 */
/** `gate`: the web's login gate is on (OWNER_AUTH). `unavailable`: the API/database could not be asked — never read as "signed out". */
export type AuthStatus = { owner_auth: boolean; passkeys: boolean; authenticated: boolean; gate: boolean; unavailable: boolean };
export type OwnerSession = { id: string; device: string | null; remember: boolean; created_at: string; last_seen_at: string | null; expires_at: string; current: boolean };
export type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null };

const TEXT: Record<string, string> = {
  unauthorized: "رمز المالك غير صحيح.", rate_limited: "محاولات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.", disabled: "الدخول الموحّد غير مفعّل على الخادم.",
  forbidden: "غير مصرّح بهذا الطلب.", exists: "هذا الجهاز مسجَّل بالفعل.", bad_request: "تعذّر إكمال الطلب.", not_found: "غير موجود.",
  unavailable: "تعذّر الوصول إلى الخادم الآن.", network: "انقطع الاتصال بالخادم.", cancelled: "أُلغي التحقق على الجهاز.",
  unsupported: "هذا المتصفح لا يدعم Face ID / مفاتيح المرور.",
};
export const authErrorText = (code: string) => TEXT[code] ?? TEXT.unavailable;
export class AuthError extends Error { constructor(public code: string) { super(authErrorText(code)); this.name = "AuthError"; } }

// ── WebAuthn JSON ⇄ binary (the server speaks the standard JSON encoding: base64url) ──
const b64uToBuf = (s: string) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const bufToB64u = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
type J = Record<string, unknown>;
const creationOptions = (o: J): PublicKeyCredentialCreationOptions => ({
  ...(o as object), challenge: b64uToBuf(o.challenge as string), user: { ...(o.user as J), id: b64uToBuf((o.user as J).id as string) } as PublicKeyCredentialUserEntity,
  excludeCredentials: ((o.excludeCredentials as J[] | undefined) ?? []).map((c) => ({ ...c, id: b64uToBuf(c.id as string) }) as PublicKeyCredentialDescriptor),
}) as PublicKeyCredentialCreationOptions;
const requestOptions = (o: J): PublicKeyCredentialRequestOptions => ({
  ...(o as object), challenge: b64uToBuf(o.challenge as string),
  allowCredentials: ((o.allowCredentials as J[] | undefined) ?? []).map((c) => ({ ...c, id: b64uToBuf(c.id as string) }) as PublicKeyCredentialDescriptor),
}) as PublicKeyCredentialRequestOptions;
function credentialJson(c: PublicKeyCredential): J {
  const r = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const response: J = { clientDataJSON: bufToB64u(r.clientDataJSON) };
  if ("attestationObject" in r && r.attestationObject) { response.attestationObject = bufToB64u(r.attestationObject); response.transports = r.getTransports?.() ?? []; }
  if ("authenticatorData" in r && r.authenticatorData) { response.authenticatorData = bufToB64u(r.authenticatorData); response.signature = bufToB64u(r.signature); if (r.userHandle) response.userHandle = bufToB64u(r.userHandle); }
  return { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults?.() ?? {}, authenticatorAttachment: c.authenticatorAttachment ?? undefined };
}

export const passkeysSupported = () => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;

type Fetch = typeof fetch;
export function createAuthClient(fetchImpl: Fetch = (...a) => fetch(...a)) {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`/api/auth/${path}`, { credentials: "same-origin", cache: "no-store", ...init }); } catch { throw new AuthError("network"); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new AuthError(typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : "unavailable");
    return body as T;
  };
  const post = (body: unknown = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async status(): Promise<AuthStatus> {
      try { const s = await call<Partial<AuthStatus>>("status"); return { owner_auth: s.owner_auth === true, passkeys: s.passkeys === true, authenticated: s.authenticated === true, gate: s.gate === true, unavailable: s.unavailable === true }; }
      catch { return { owner_auth: false, passkeys: false, authenticated: false, gate: false, unavailable: true }; }
    },
    loginCode: async (code: string, remember: boolean) => { await call("login/code", post({ code, remember })); },
    async loginPasskey(remember: boolean): Promise<void> {
      if (!passkeysSupported()) throw new AuthError("unsupported");
      const { options } = await call<{ options: J }>("passkeys/login/options", post());
      let cred: Credential | null;
      try { cred = await navigator.credentials.get({ publicKey: requestOptions(options) }); } catch { throw new AuthError("cancelled"); }
      if (!cred) throw new AuthError("cancelled");
      await call("passkeys/login/verify", post({ credential: credentialJson(cred as PublicKeyCredential), remember }));
    },
    async registerPasskey(name: string): Promise<void> {
      if (!passkeysSupported()) throw new AuthError("unsupported");
      const { options } = await call<{ options: J }>("passkeys/register/options", post());
      let cred: Credential | null;
      try { cred = await navigator.credentials.create({ publicKey: creationOptions(options) }); } catch { throw new AuthError("cancelled"); }
      if (!cred) throw new AuthError("cancelled");
      await call("passkeys/register/verify", post({ credential: credentialJson(cred as PublicKeyCredential), name }));
    },
    sessions: async () => (await call<{ sessions: OwnerSession[] }>("sessions")).sessions,
    /** Ends one session; `signedOut` when it was this device's own. */
    endSession: async (id: string) => (await call<{ signedOut?: boolean }>("sessions/revoke", post({ id }))).signedOut === true,
    passkeys: async () => (await call<{ passkeys: Passkey[] }>("passkeys")).passkeys,
    removePasskey: async (id: string) => { await call("passkeys/delete", post({ id })); },
    logout: async (everywhere = false) => { await call(everywhere ? "logout-all" : "logout", post()); },
  };
}
export const authClient = createAuthClient();
