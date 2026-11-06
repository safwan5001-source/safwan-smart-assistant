import { assistantService } from "@/lib/assistant";

type Prompt = (o: { title: string; label: string; multiline?: boolean; secret?: boolean }) => Promise<string | null>;

/** Makes sure the owner cookie exists, asking for the access code once if not. Throws an Arabic message the UI can show as-is. */
export async function ensureClaudeSession(prompt: Prompt): Promise<void> {
  const session = await assistantService.sessionStatus();
  if (!session.enabled) throw new Error("بوابة Claude غير مفعلة على خادم باشت.");
  if (session.authenticated) return;
  const code = await prompt({ title: "فتح دردشة Claude", label: "رمز وصول المالك", multiline: false, secret: true });
  if (!code) throw new Error("لم يتم فتح جلسة Claude.");
  if (!(await assistantService.unlock(code))) throw new Error("رمز الوصول غير صحيح أو انتهت محاولة الدخول.");
}
