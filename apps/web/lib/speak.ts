/**
 * Spoken alerts (optional). Uses the browser's speechSynthesis with an Arabic voice.
 * Foreground only: iOS does NOT allow speech in the background, so a closed/locked app can only show a
 * system notification (its text can be read by VoiceOver / Siri "announce notifications", which is an OS setting).
 */

const MASC = ["صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
// numbers 3–10 take the OPPOSITE gender of the counted noun: «ثلاث دقائق» (fem. noun) vs «ثلاثة أيام» (masc. noun)
const FEM = ["صفر", "واحدة", "اثنتان", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثمان", "تسع", "عشر", "إحدى عشرة", "اثنتا عشرة", "ثلاث عشرة", "أربع عشرة", "خمس عشرة", "ست عشرة", "سبع عشرة", "ثماني عشرة", "تسع عشرة"];
const TENS_OBL = ["", "", "عشرين", "ثلاثين", "أربعين", "خمسين", "ستين", "سبعين", "ثمانين", "تسعين"];

/** 0–99 in words. `feminineNoun`: the counted noun is feminine (دقيقة، ساعة) → numerals 3–10 use the short form. */
export function arabicNumber(n: number, feminineNoun = false): string {
  const names = feminineNoun ? FEM : MASC;
  if (n < 20) return names[n];
  const t = Math.floor(n / 10), u = n % 10;
  return u === 0 ? TENS_OBL[t] : `${names[u]} و${TENS_OBL[t]}`;
}

function counted(n: number, one: string, two: string, few: string, many: string, fem: boolean): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${arabicNumber(n, fem)} ${few}`;
  return `${arabicNumber(n, fem)} ${many}`;
}

/** «ثلاثين دقيقة» · «ساعة ونصف» · «ساعتين» · «ثلاث ساعات» · «يوم» */
export function durationPhrase(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  const mins = (n: number) => counted(n, "دقيقة", "دقيقتين", "دقائق", "دقيقة", true);
  if (m < 60) return mins(m);
  if (m < 1440) {
    const h = Math.floor(m / 60), r = m % 60;
    const hours = counted(h, "ساعة", "ساعتين", "ساعات", "ساعة", true);
    if (r === 0) return hours;
    if (r === 30) return `${hours} ونصف`;
    if (r === 15) return `${hours} وربع`;
    return `${hours} و${mins(r)}`;
  }
  const d = Math.floor(m / 1440);
  return counted(d, "يوم", "يومين", "أيام", "يوماً", false);
}

const NOUN_TITLES = /^(?:اجتماع|موعد|مكالمة|اتصال|مقابلة|محاضرة|درس|حصة|رحلة|صلاة|دواء|جلسة|لقاء|امتحان|اختبار|تسليم|حجز|زيارة|مناسبة)/;
/** «لديك اجتماع بعد ثلاثين دقيقة» for event-like titles, otherwise «تذكير: … بعد …». */
export function spokenReminder(title: string, minutesBefore: number, kind: "lead" | "due" | "snooze" = "due"): string {
  const t = title.trim();
  const noun = NOUN_TITLES.test(t);
  if (kind === "lead" && minutesBefore > 0) return noun ? `لديك ${t} بعد ${durationPhrase(minutesBefore)}` : `تذكير: ${t}، بعد ${durationPhrase(minutesBefore)}`;
  if (kind === "snooze") return noun ? `تذكير مؤجَّل: لديك ${t}` : `تذكير مؤجَّل: ${t}`;
  return noun ? `حان وقت ${t}` : `حان وقت التذكير: ${t}`;
}

export type SpeakResult = "spoken" | "unsupported" | "no_voice" | "blocked" | "error";
type Synth = {
  getVoices: () => { lang: string; name: string }[]; speak: (u: unknown) => void; cancel: () => void;
};
export type SpeechDeps = { synth?: Synth | null; Utterance?: new (text: string) => Record<string, unknown> };

export function arabicVoice(voices: { lang: string; name: string }[]) {
  const ar = voices.filter((v) => /^ar(-|_|$)/i.test(v.lang));
  return ar.find((v) => /^ar[-_]SA/i.test(v.lang)) ?? ar[0] ?? null;
}

export function createSpeaker(deps: SpeechDeps = {}) {
  const synth = () => (deps.synth !== undefined ? deps.synth : typeof window !== "undefined" && "speechSynthesis" in window ? (window.speechSynthesis as unknown as Synth) : null);
  const U = () => deps.Utterance ?? (typeof window !== "undefined" ? (window as unknown as { SpeechSynthesisUtterance?: new (t: string) => Record<string, unknown> }).SpeechSynthesisUtterance : undefined);
  return {
    supported: () => !!synth() && !!U(),
    hasArabicVoice: () => { const s = synth(); return !!s && !!arabicVoice(s.getVoices()); },
    async speak(text: string, opts: { volume: number }): Promise<SpeakResult> {
      const s = synth(), Ctor = U();
      if (!s || !Ctor) return "unsupported";
      const voice = arabicVoice(s.getVoices());
      if (!voice) return "no_voice";
      return new Promise<SpeakResult>((resolve) => {
        const u = new Ctor(text);
        u.lang = voice.lang; u.voice = voice; u.volume = Math.min(1, Math.max(0, opts.volume)); u.rate = 0.95;
        let settled = false;
        const fin = (r: SpeakResult) => { if (!settled) { settled = true; resolve(r); } };
        u.onstart = () => fin("spoken");
        u.onerror = (e: { error?: string }) => fin(e?.error === "not-allowed" ? "blocked" : "error");
        try { s.cancel(); s.speak(u); } catch { fin("error"); }
        setTimeout(() => fin("blocked"), 2500); // started nothing → autoplay-style block
      });
    },
    cancel() { try { synth()?.cancel(); } catch { /* ignore */ } },
  };
}
let sharedSpeaker: ReturnType<typeof createSpeaker> | null = null;
export const speaker = () => (sharedSpeaker ??= createSpeaker());
