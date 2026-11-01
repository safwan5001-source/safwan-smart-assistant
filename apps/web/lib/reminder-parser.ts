/**
 * Arabic natural-language reminder parser (deterministic, no AI, no network).
 *
 *   «ذكرني بكرة الساعة 9 أراجع الفواتير»  →  needs clarification: 9 صباحاً أم مساءً؟
 *   «ذكرني بكرة الساعة 9 صباحاً أراجع الفواتير» → ready, tomorrow 09:00 (Asia/Riyadh)
 *   «ذكرني بعد 30 دقيقة أتصل بأحمد»            → ready (relative times are never ambiguous)
 *
 * Ambiguity is never guessed away: a clock hour 1–12 without a period word, a missing time/date,
 * an empty title or a time already in the past all return `clarify` so the UI can ask BEFORE saving.
 * Works on typed text and on dictated text (the dictation feeds the same chat input),
 * including Eastern Arabic digits and spelled-out numbers («الساعة تسعة ونصف»).
 */
import { DEFAULT_TZ, addDays, dateKey, daysInMonth, parseDateKey, pad2, zonedToUtc, zoneParts, formatTimeInZone } from "./tz";
import { REMINDER_LIMITS, type ReminderInput, type ReminderPriority, type RepeatKind } from "./reminders";

export type Clarification = {
  reason: "title" | "time" | "period" | "date" | "past";
  question: string;
  /** ready-made answers the UI can offer (each is a patch over the draft) */
  options: { label: string; patch: Partial<ReminderInput> }[];
};
export type ParseOutcome =
  | { kind: "none" }
  | { kind: "ready"; draft: ReminderInput; notes: string[] }
  | { kind: "clarify"; draft: Partial<ReminderInput>; clarification: Clarification; notes: string[] };

// ── folding (1:1 length preserving so token spans stay valid) ───────────────
const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const fold = (s: string) =>
  [...s].map((ch) => {
    const i = AR_DIGITS.indexOf(ch);
    if (i >= 0) return String(i);
    if ("أإآٱ".includes(ch)) return "ا";
    if (ch === "ى") return "ي";
    if (ch === "ة") return "ه";
    if (ch === "،" || ch === "؟" || ch === "،") return " ";
    return ch.toLowerCase();
  }).join("");

type Tok = { raw: string; f: string; used: boolean };

// ── vocab ───────────────────────────────────────────────────────────────────
const TRIGGER = /^(?:\/)?(?:ذكرني|ذكرنا|ذكرلي|ذكر لي|نبهني|نبهنا|نبهلي|نبه لي|اضف تذكير|اضبط تذكير|انشئ تذكير|سوي تذكير|ضع تذكير|ضع لي تذكير|ابغى تذكير|ابي تذكير|تذكير)(?=\s|$)/;
const POLITE = /^(?:(?:لو سمحت|من فضلك|ممكن|يا صفوان|صفوان|هلا|مرحبا|اهلا)\s+)+/;
export function isReminderIntent(text: string): boolean {
  const f = fold(text.replace(DIACRITICS, "")).trim().replace(POLITE, "");
  return TRIGGER.test(f);
}

const UNITS: Record<string, number> = {
  واحد: 1, واحده: 1, احد: 1, اثنين: 2, اثنان: 2, اثنتين: 2, اثنا: 2, اثني: 2, اثنتا: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4,
  خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7, ثمان: 8, ثماني: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10,
};
const TENS: Record<string, number> = {
  عشرين: 20, عشرون: 20, ثلاثين: 30, ثلاثون: 30, اربعين: 40, اربعون: 40, خمسين: 50, خمسون: 50, ستين: 60, ستون: 60,
  سبعين: 70, سبعون: 70, ثمانين: 80, ثمانون: 80, تسعين: 90, تسعون: 90,
};
const WEEKDAY: Record<string, number> = { الاحد: 0, الاثنين: 1, الثلاثاء: 2, الاربعاء: 3, الخميس: 4, الجمعه: 5, السبت: 6, احد: 0, اثنين: 1, ثلاثاء: 2, اربعاء: 3, خميس: 4, جمعه: 5, سبت: 6 };
const MONTHS: Record<string, number> = {
  يناير: 1, "كانون الثاني": 1, فبراير: 2, شباط: 2, مارس: 3, اذار: 3, ابريل: 4, نيسان: 4, مايو: 5, ايار: 5, يونيو: 6, حزيران: 6,
  يوليو: 7, تموز: 7, اغسطس: 8, اب: 8, سبتمبر: 9, ايلول: 9, اكتوبر: 10, "تشرين الاول": 10, نوفمبر: 11, "تشرين الثاني": 11, ديسمبر: 12, "كانون الاول": 12,
};
const AM = new Set(["صباحا", "الصباح", "الصبح", "صباحاً", "فجرا", "الفجر", "ص", "am", "a.m"]);
const NOON = new Set(["ظهرا", "الظهر", "ضحى", "الضحى"]);
const PM = new Set(["مساء", "المساء", "عصرا", "العصر", "بالليل", "ليلا", "الليل", "م", "pm", "p.m", "مغرب", "المغرب"]);

const stripW = (s: string) => (s.startsWith("و") && s.length > 1 ? s.slice(1) : s);

function numAt(t: Tok[], i: number): { v: number; len: number } | null {
  const a = t[i]; if (!a || a.used) return null;
  let m = /^(\d+)(?:[.,](\d+))?$/.exec(a.f);
  if (m) return { v: m[2] ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1], 10), len: 1 };
  const w = stripW(a.f);
  if (w in TENS) return { v: TENS[w], len: 1 };
  if (w in UNITS) {
    const u = UNITS[w], nx = t[i + 1];
    if (nx && !nx.used && (nx.f === "عشر" || nx.f === "عشره") && w !== "عشر" && w !== "عشره") return { v: 10 + u, len: 2 };
    if (nx && !nx.used && nx.f.startsWith("و") && stripW(nx.f) in TENS && u < 10) return { v: u + TENS[stripW(nx.f)], len: 2 };
    return { v: u, len: 1 };
  }
  m = /^(\d+)(ص|م)$/.exec(a.f);
  if (m) return { v: parseInt(m[1], 10), len: 1 };
  return null;
}

type Dur = { minutes: number; days: number; len: number };
const MIN_UNIT = /^(?:دقيقه|دقائق|دقايق|دقيقتين|دقيقتان)$/;
const HOUR_UNIT = /^(?:ساعه|ساعات|ساعتين|ساعتان)$/;
const DAY_UNIT = /^(?:يوم|ايام|يومين|يومان)$/;
const WEEK_UNIT = /^(?:اسبوع|اسابيع|اسبوعين|اسبوعان)$/;
const isUnit = (s: string) => MIN_UNIT.test(s) || HOUR_UNIT.test(s) || DAY_UNIT.test(s) || WEEK_UNIT.test(s);
const dual = (s: string) => /(?:تين|تان|ين|ان)$/.test(s) && /^(?:دقيقتين|دقيقتان|ساعتين|ساعتان|يومين|يومان|اسبوعين|اسبوعان)$/.test(s);

function unitValue(u: string, n: number): { minutes: number; days: number } {
  if (MIN_UNIT.test(u)) return { minutes: n, days: 0 };
  if (HOUR_UNIT.test(u)) return { minutes: n * 60, days: 0 };
  if (DAY_UNIT.test(u)) return { minutes: 0, days: n };
  return { minutes: 0, days: n * 7 };
}

/** Parses a duration starting at token i: «30 دقيقة», «ساعتين», «نصف ساعة», «ساعة ونصف», «ثلاثين دقيقة». */
function durAt(t: Tok[], i: number): Dur | null {
  const a = t[i]; if (!a || a.used) return null;
  const take = (len: number, v: { minutes: number; days: number }): Dur => ({ ...v, len });
  if (a.f === "نصف" || a.f === "نص") { const u = t[i + 1]?.f; if (u && HOUR_UNIT.test(u)) return take(2, { minutes: 30, days: 0 }); if (u && DAY_UNIT.test(u)) return take(2, { minutes: 12 * 60, days: 0 }); }
  if (a.f === "ربع") { const u = t[i + 1]?.f; if (u && HOUR_UNIT.test(u)) return take(2, { minutes: 15, days: 0 }); }
  if (a.f === "ثلث") { const u = t[i + 1]?.f; if (u && HOUR_UNIT.test(u)) return take(2, { minutes: 20, days: 0 }); }
  if (isUnit(a.f)) {
    const n = dual(a.f) ? 2 : 1;
    let v = unitValue(a.f, n), len = 1;
    // «ساعة ونصف» / «ساعة وربع» / «ساعتين ونصف»
    if (HOUR_UNIT.test(a.f)) {
      const nx = t[i + 1]?.f ?? "";
      const extra = /^(?:ونص|ونصف)$/.test(nx) ? 30 : nx === "وربع" ? 15 : nx === "وثلث" ? 20 : 0;
      if (extra) { v = { minutes: v.minutes + extra, days: 0 }; len = 2; }
    }
    return take(len, v);
  }
  const n = numAt(t, i);
  if (n) {
    const u = t[i + n.len]?.f;
    if (u && isUnit(u)) {
      const v = unitValue(u, n.v);
      let len = n.len + 1;
      // «ساعة و 15 دقيقة» chains: N ساعه و M دقيقه
      if (HOUR_UNIT.test(u)) {
        const j = i + len; const nx = t[j]; const wf = nx ? stripW(nx.f) : "";
        if (nx && nx.f.startsWith("و")) {
          const nn = nx.f === "و" ? numAt(t, j + 1) : (() => { const copy = [{ ...nx, f: wf }, ...t.slice(j + 1)]; return numAt(copy, 0); })();
          const skip = nx.f === "و" ? 1 : 0;
          const unitTok = nn ? t[j + skip + nn.len]?.f : undefined;
          if (nn && unitTok && MIN_UNIT.test(unitTok)) { v.minutes += nn.v; len = j + skip + nn.len + 1 - i; }
        }
      }
      return take(len, v);
    }
  }
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
type TimeSpec = { h: number; mi: number; ambiguous: boolean; certain24: boolean };

export function parseReminderText(text: string, now: number, tz: string = DEFAULT_TZ): ParseOutcome {
  const original = text.replace(DIACRITICS, "").replace(/\s+/g, " ").trim();
  let folded = fold(original);
  const polite = POLITE.exec(folded);
  const head = folded.slice(polite ? polite[0].length : 0);
  const trig = TRIGGER.exec(head);
  if (!trig) return { kind: "none" };
  const cut = (polite ? polite[0].length : 0) + trig[0].length;
  const body = original.slice(cut).trim();
  folded = fold(body);
  const toks: Tok[] = [];
  const re = /\S+/g; let m: RegExpExecArray | null;
  const rawToks = body.split(/\s+/).filter(Boolean);
  while ((m = re.exec(folded))) toks.push({ raw: rawToks[toks.length] ?? m[0], f: m[0].replace(/^[.,؛:!]+|[.,؛:!]+$/g, ""), used: false });
  const notes: string[] = [];
  const mark = (i: number, len: number) => { for (let k = 0; k < len; k++) if (toks[i + k]) toks[i + k].used = true; };

  const today = zoneParts(now, tz);
  const todayDate = { y: today.y, m: today.m, d: today.d };

  let repeat: RepeatKind = "none";
  let weekday: number | null = null;       // from «كل خميس» / «يوم الأحد»
  let monthDay: number | null = null;      // from «يوم 25»
  let date: { y: number; m: number; d: number } | null = null;
  let relMinutes: number | null = null;
  let relDays = 0;
  let lead = 0;
  let time: TimeSpec | null = null;
  let timeExplicitPeriod = false;
  let priority: ReminderPriority = "normal";

  // 1) repeat
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i].f;
    if (toks[i].used) continue;
    if (a === "كل") {
      const n1 = toks[i + 1]?.f, n2 = toks[i + 2]?.f;
      if (n1 === "يوم" && n2 && n2 in WEEKDAY) { repeat = "weekly"; weekday = WEEKDAY[n2]; mark(i, 3); continue; }
      if (n1 && n1 in WEEKDAY) { repeat = "weekly"; weekday = WEEKDAY[n1]; mark(i, 2); continue; }
      if (n1 === "يوم") { repeat = "daily"; mark(i, 2); continue; }
      if (n1 === "اسبوع") { repeat = "weekly"; mark(i, 2); continue; }
      if (n1 === "شهر") { repeat = "monthly"; mark(i, 2); continue; }
    }
    if (a === "يوميا") { repeat = "daily"; mark(i, 1); }
    else if (a === "اسبوعيا") { repeat = "weekly"; mark(i, 1); }
    else if (a === "شهريا") { repeat = "monthly"; mark(i, 1); }
  }

  // 2) lead time: «قبل الموعد بربع ساعة» / «قبلها بنصف ساعة» / «قبل 30 دقيقة»
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].used || !/^قبل(?:ها|ه)?$/.test(toks[i].f)) continue;
    let j = i + 1;
    while (toks[j] && ["الموعد", "الاجتماع", "ذلك", "الوقت", "الحدث"].includes(toks[j].f)) j++;
    if (toks[j]?.f === "ب" ) j++;
    // «بنصف ساعة»: strip the glued ب
    const t2 = toks.map((x) => ({ ...x }));
    if (t2[j] && /^ب.+/.test(t2[j].f) && !numAt(t2, j) && !durAt(t2, j)) t2[j] = { ...t2[j], f: t2[j].f.slice(1) };
    if (t2[j] && /^ب\d/.test(t2[j].f)) t2[j] = { ...t2[j], f: t2[j].f.slice(1) };
    const d = durAt(t2, j);
    if (d && d.days === 0 && d.minutes > 0) { lead = d.minutes; mark(i, j + d.len - i); }
    else if (d && d.days > 0 && d.minutes === 0) { lead = d.days * 1440; mark(i, j + d.len - i); }
    break;
  }

  // 3) «بعد …»: relative duration, «بعد غد / بعد بكرة»
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].used || toks[i].f !== "بعد") continue;
    const nx = toks[i + 1]?.f;
    if (nx === "غد" || nx === "بكره" || nx === "بكرا" || nx === "غدا") { date = addDays(todayDate, 2); mark(i, 2); continue; }
    const d = durAt(toks, i + 1);
    if (d) {
      if (d.days === 0) relMinutes = (relMinutes ?? 0) + d.minutes; else relDays += d.days;
      mark(i, 1 + d.len);
    }
  }

  // 4) date words
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].used) continue;
    const a = toks[i].f;
    if (a === "اليوم") { date = todayDate; mark(i, 1); }
    else if (a === "بكره" || a === "بكرا" || a === "غدا" || a === "باكر" || a === "غد") { date = addDays(todayDate, 1); mark(i, 1); }
    else if (a === "بعدغد") { date = addDays(todayDate, 2); mark(i, 1); }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { const p = parseDateKey(a); if (p) { date = p; mark(i, 1); } }
    else if (/^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(a)) {
      const [d, mo, yy] = a.split(/[/-]/).map(Number);
      const y = yy ? (yy < 100 ? 2000 + yy : yy) : today.y;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) { date = { y, m: mo, d }; mark(i, 1); }
    }
  }
  // weekday names («يوم الأحد», «الخميس القادم») unless already used by «كل»
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].used) continue;
    const a = toks[i].f;
    if (a in WEEKDAY && /^ال/.test(a)) {
      const prev = toks[i - 1];
      let start = i, len = 1;
      if (prev && !prev.used && prev.f === "يوم") { start = i - 1; len = 2; }
      if (["القادم", "الجاي", "الجاى", "القادمه"].includes(toks[i + 1]?.f ?? "")) len++;
      weekday = WEEKDAY[a]; mark(start, len);
      break;
    }
  }
  // «يوم 25» / «في 25 نوفمبر» / «15 نوفمبر»
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].used) continue;
    const n = numAt(toks, i);
    if (!n || n.v < 1 || n.v > 31 || !Number.isInteger(n.v)) continue;
    const nx = toks[i + n.len]?.f ?? "", nx2 = toks[i + n.len + 1]?.f ?? "";
    const mName = nx in MONTHS ? nx : `${nx} ${nx2}` in MONTHS ? `${nx} ${nx2}` : null;
    const prev = toks[i - 1];
    if (mName) {
      const mo = MONTHS[mName];
      let y = today.y;
      if (n.v > daysInMonth(y, mo)) continue;
      if (zonedToUtc({ y, m: mo, d: n.v, h: 23, mi: 59 }, tz) < now) { y += 1; notes.push("التاريخ هذا العام مضى؛ اعتُمد العام القادم."); }
      date = { y, m: mo, d: n.v };
      const extra = mName.includes(" ") ? 2 : 1;
      const st = prev && !prev.used && (prev.f === "في" || prev.f === "يوم") ? i - 1 : i;
      mark(st, i + n.len + extra - st);
      break;
    }
    if (prev && !prev.used && prev.f === "يوم" && !isUnit(toks[i + n.len]?.f ?? "")) { monthDay = n.v; mark(i - 1, 1 + n.len); break; }
  }

  // 5) time of day
  const periodAt = (j: number): { kind: "am" | "noon" | "pm"; len: number } | null => {
    let k = j, skip = 0;
    while (toks[k] && !toks[k].used && ["في", "من", "ب", "بعد"].includes(toks[k].f) && toks[k + 1]) { k++; skip++; }
    const p = toks[k]; if (!p || p.used) return null;
    const w = p.f.replace(/^ب(?=ال)/, "");
    const kind = AM.has(w) ? "am" : NOON.has(w) ? "noon" : PM.has(w) ? "pm" : null;
    return kind ? { kind, len: skip + 1 } : null;
  };
  for (let i = 0; i < toks.length && !time; i++) {
    if (toks[i].used) continue;
    let j = i;
    const hasKeyword = toks[j].f === "الساعه" || toks[j].f === "ساعه" || (toks[j].f === "عند" && toks[j + 1]?.f === "الساعه");
    if (hasKeyword) j += toks[j].f === "عند" ? 2 : 1;
    const a = toks[j]; if (!a || a.used) continue;
    // hour
    let h: number | null = null, mi = 0, len = 0, colon = false, suffixPeriod: "am" | "pm" | null = null, leadingZero = false;
    const cm = /^(\d{1,2}):(\d{2})$/.exec(a.f);
    const sm = /^(\d{1,2})(ص|م)$/.exec(a.f);
    if (cm) { h = +cm[1]; mi = +cm[2]; len = 1; colon = true; leadingZero = cm[1].length === 2 && cm[1].startsWith("0"); }
    else if (sm) { h = +sm[1]; len = 1; suffixPeriod = sm[2] === "ص" ? "am" : "pm"; }
    else { const n = numAt(toks, j); if (n && Number.isInteger(n.v) && n.v >= 0 && n.v <= 24 && !isUnit(toks[j + n.len]?.f ?? "")) { h = n.v; len = n.len; } }
    if (h === null) continue;
    let k = j + len;
    // minute modifiers
    const nx = toks[k]?.f ?? "";
    let modLen = 0;
    if (/^(?:ونص|ونصف)$/.test(nx)) { mi = 30; modLen = 1; }
    else if (nx === "وربع") { mi = 15; modLen = 1; }
    else if (nx === "وثلث") { mi = 20; modLen = 1; }
    else if (nx === "و" && /^(?:نص|نصف)$/.test(toks[k + 1]?.f ?? "")) { mi = 30; modLen = 2; }
    else if (nx === "الا" || nx === "الّا") {
      const q = toks[k + 1]?.f;
      if (q === "ربع") { mi = 45; h = h - 1; modLen = 2; } else if (q === "ثلث") { mi = 40; h = h - 1; modLen = 2; }
      else { const n2 = numAt(toks, k + 1); if (n2 && n2.v > 0 && n2.v < 60) { mi = 60 - n2.v; h = h - 1; modLen = 1 + n2.len; } }
    } else if (nx.startsWith("و") && nx !== "و") {
      const copy = [{ ...toks[k], f: stripW(nx) }, ...toks.slice(k + 1)];
      const n2 = numAt(copy, 0);
      if (n2 && n2.v > 0 && n2.v < 60 && (isUnit(toks[k + n2.len]?.f ?? "") || /^\d+$/.test(stripW(nx)))) {
        mi = n2.v; modLen = n2.len + (MIN_UNIT.test(toks[k + n2.len]?.f ?? "") ? 1 : 0);
      }
    }
    k += modLen;
    const period = suffixPeriod ? { kind: suffixPeriod, len: 0 } : periodAt(k);
    // a bare number is only a time when anchored by «الساعة», a colon or a period word
    if (!hasKeyword && !colon && !period) continue;
    if (h < 0) h = 23;
    let ambiguous = false, certain24 = false;
    if (period) {
      timeExplicitPeriod = true;
      if (period.kind === "am") { if (h === 12) h = 0; }
      else if (period.kind === "noon") { if (h < 11) h += 12; /* 11/12 stay */ }
      else { // pm / evening / night
        if (h === 12) ambiguous = true; // «12 ليلاً» is midnight, «12 مساءً» is unclear → ask
        else if (h < 12) h += 12;
      }
    } else if (h > 12 || h === 0 || (colon && leadingZero) ) certain24 = true;
    else ambiguous = true; // 1–12 with no period
    if (h > 23 || mi > 59) continue;
    time = { h, mi, ambiguous, certain24 };
    mark(i, k + (period ? period.len : 0) - i);
  }
  if (!time) {
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].used) continue;
      if (NOON.has(toks[i].f) && toks[i].f !== "ضحى" && toks[i].f !== "الضحى") { time = { h: 12, mi: 0, ambiguous: false, certain24: true }; mark(i, 1); break; }
      if (toks[i].f === "منتصف" && toks[i + 1]?.f === "الليل") { time = { h: 0, mi: 0, ambiguous: false, certain24: true }; mark(i, 2); break; }
    }
  }

  // 6) priority hint (word stays in the title)
  if (toks.some((x) => ["مهم", "عاجل", "ضروري", "ضروريه", "مهمه"].includes(x.f))) priority = "high";

  // 7) title
  const leftovers = toks.filter((x) => !x.used).map((x) => x.raw);
  while (leftovers.length && /^(?:ان|اني|انني|أن|أني|ب|بـ|ل|لـ|عشان|علشان|في|على|عند|الى|إلى|و|ثم|وبعدين)$/.test(fold(leftovers[0]))) leftovers.shift();
  while (leftovers.length && /^(?:في|على|عند|و|ب|ل)$/.test(fold(leftovers[leftovers.length - 1]))) leftovers.pop();
  const title = leftovers.join(" ").replace(/\s+/g, " ").trim().slice(0, REMINDER_LIMITS.title);

  // ── assemble ─────────────────────────────────────────────────────────────
  const base: Partial<ReminderInput> = { tz, repeat, leadMinutes: lead, priority };
  if (title) base.title = title;
  const askTitle: Clarification = { reason: "title", question: "ماذا تريد أن أذكّرك به؟", options: [] };

  // relative: «بعد 30 دقيقة» / «بعد ساعتين» → absolute, never ambiguous
  if (relMinutes !== null || relDays > 0) {
    if (repeat !== "none") notes.push("التكرار يبدأ بعد هذه المدة.");
    let at: number;
    if (relDays > 0 && relMinutes === null) {
      if (!time) {
        return { kind: "clarify", draft: { ...base, date: dateKey(addDays(todayDate, relDays)) }, notes,
          clarification: { reason: "time", question: "في أي ساعة تريد التذكير؟", options: [] } };
      }
      if (time.ambiguous) return ambiguousPeriod(base, dateKey(addDays(todayDate, relDays)), time, tz, notes);
      const d = addDays(todayDate, relDays);
      at = zonedToUtc({ ...d, h: time.h, mi: time.mi }, tz);
    } else {
      at = now + ((relMinutes ?? 0) + relDays * 1440) * 60_000;
    }
    const p = zoneParts(at, tz);
    const draft: ReminderInput = { ...(base as ReminderInput), title, date: dateKey(p), time: `${pad2(p.h)}:${pad2(p.mi)}` };
    if (!title) return { kind: "clarify", draft, notes, clarification: askTitle };
    notes.push(`الموعد: ${formatTimeInZone(at, tz)}`);
    return { kind: "ready", draft, notes };
  }

  // resolve the date
  let day = date;
  if (!day && weekday !== null) {
    const cur = today.weekday;
    let add = (weekday - cur + 7) % 7;
    if (add === 0 && (!time || time.ambiguous)) add = 0; // decided below once the time is known
    day = addDays(todayDate, add);
  }
  if (!day && monthDay !== null) {
    let y = today.y, mo = today.m;
    const clamp = (yy: number, mm: number) => Math.min(monthDay!, daysInMonth(yy, mm));
    let cand = { y, m: mo, d: clamp(y, mo) };
    const endOfCand = zonedToUtc({ ...cand, h: 23, mi: 59 }, tz);
    if (endOfCand < now) { mo += 1; if (mo > 12) { mo = 1; y += 1; } cand = { y, m: mo, d: clamp(y, mo) }; }
    day = cand;
  }

  if (!time) {
    const d = day ? dateKey(day) : undefined;
    return { kind: "clarify", draft: { ...base, ...(d ? { date: d } : {}) }, notes,
      clarification: { reason: "time", question: day || repeat !== "none" ? "في أي ساعة تريد التذكير؟" : "متى تريد أن أذكّرك؟ حدّد اليوم والساعة.", options: [] } };
  }

  // no date: next occurrence of that wall-clock time (today if still ahead, otherwise tomorrow)
  const resolveFor = (t: { h: number; mi: number }, dd: { y: number; m: number; d: number } | null) => {
    if (dd) return dd;
    const todayAt = zonedToUtc({ ...todayDate, h: t.h, mi: t.mi }, tz);
    return todayAt > now ? todayDate : addDays(todayDate, 1);
  };

  if (time.ambiguous) {
    // if exactly one reading is still ahead on the target day, there is no real ambiguity
    const hAm = time.h % 12, hPm = (time.h % 12) + 12;
    const options = [{ h: hAm, label: "صباحاً" }, { h: hPm, label: "مساءً" }];
    const dayFor = (h: number) => resolveFor({ h, mi: time!.mi }, day);
    const ahead = options.filter((o) => zonedToUtc({ ...dayFor(o.h), h: o.h, mi: time!.mi }, tz) > now);
    if (!(day && day.d === todayDate.d && day.m === todayDate.m && ahead.length === 1) || timeExplicitPeriod) {
      return ambiguousPeriod(base, day ? dateKey(day) : undefined, time, tz, notes, day, resolveFor);
    }
    time = { h: ahead[0].h, mi: time.mi, ambiguous: false, certain24: false };
    notes.push(`فُسّر الوقت ${pad2(time.h)}:${pad2(time.mi)} لأن الآخر مضى.`);
  }

  let finalDay = resolveFor(time, day);
  if (weekday !== null && !date) {
    const at0 = zonedToUtc({ ...finalDay, h: time.h, mi: time.mi }, tz);
    if (at0 <= now) finalDay = addDays(finalDay, 7);
  }
  const at = zonedToUtc({ ...finalDay, h: time.h, mi: time.mi }, tz);
  const timeStr = `${pad2(time.h)}:${pad2(time.mi)}`;
  const draft: ReminderInput = { ...(base as ReminderInput), title, date: dateKey(finalDay), time: timeStr };
  if (!title) return { kind: "clarify", draft, notes, clarification: askTitle };
  if (at <= now && repeat === "none") {
    const tomorrow = dateKey(addDays(finalDay, 1));
    return { kind: "clarify", draft, notes,
      clarification: { reason: "past", question: "هذا الوقت مضى. هل تقصد غداً في الوقت نفسه؟", options: [{ label: "نعم، غداً", patch: { date: tomorrow } }] } };
  }
  if (!date && !weekday && !monthDay && repeat === "none") notes.push(finalDay.d === todayDate.d && finalDay.m === todayDate.m ? "اليوم" : "غداً (لأن الوقت مضى اليوم)");
  return { kind: "ready", draft, notes };
}

function ambiguousPeriod(
  base: Partial<ReminderInput>, dateStr: string | undefined, time: TimeSpec, tz: string, notes: string[],
  day?: { y: number; m: number; d: number } | null,
  resolveFor?: (t: { h: number; mi: number }, dd: { y: number; m: number; d: number } | null) => { y: number; m: number; d: number },
): ParseOutcome {
  const mi = time.mi;
  const make = (h: number, label: string) => {
    const patch: Partial<ReminderInput> = { time: `${pad2(h)}:${pad2(mi)}` };
    if (!dateStr && resolveFor) patch.date = dateKey(resolveFor({ h, mi }, day ?? null));
    return { label: `${time.h % 12 === 0 ? 12 : time.h % 12}:${pad2(mi)} ${label}`, patch };
  };
  return {
    kind: "clarify", draft: { ...base, ...(dateStr ? { date: dateStr } : {}) }, notes,
    clarification: {
      reason: "period",
      question: `الساعة ${time.h % 12 === 0 ? 12 : time.h % 12}${mi ? ":" + pad2(mi) : ""} صباحاً أم مساءً؟`,
      options: [make(time.h % 12, "صباحاً"), make((time.h % 12) + 12, "مساءً")],
    },
  };
}

/** Combines a draft with the user's answer(s); returns a complete input once nothing is missing. */
export function completeDraft(draft: Partial<ReminderInput>, patch: Partial<ReminderInput> = {}): ReminderInput | null {
  const d = { ...draft, ...patch };
  if (!d.title?.trim() || !d.time || !d.date) return null;
  return d as ReminderInput;
}
