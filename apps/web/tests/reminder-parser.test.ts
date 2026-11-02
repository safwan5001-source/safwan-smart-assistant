import { describe, expect, it } from "vitest";
import { isReminderIntent, parseReminderText, completeDraft } from "@/lib/reminder-parser";
import { createReminder } from "@/lib/reminders";

const riyadh = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 3, mi);
// Monday 2 Nov 2026, 02:10 Asia/Riyadh
const NOW = riyadh(2026, 11, 2, 2, 10);
const AFTERNOON = riyadh(2026, 11, 2, 14, 0);

const ready = (text: string, now = NOW) => {
  const r = parseReminderText(text, now);
  if (r.kind !== "ready") throw new Error(`expected ready for «${text}», got ${JSON.stringify(r)}`);
  return r.draft;
};
const clarify = (text: string, now = NOW) => {
  const r = parseReminderText(text, now);
  if (r.kind !== "clarify") throw new Error(`expected clarify for «${text}», got ${JSON.stringify(r)}`);
  return r;
};

describe("intent detection", () => {
  it("recognises reminder commands and ignores ordinary chat", () => {
    for (const t of ["ذكرني بكرة الساعة 9 أراجع الفواتير", "نبهني بعد ساعة", "لو سمحت ذكرني بعد 5 دقائق", "/ذكرني بعد ساعة اتصل", "ذكّرني غدا"]) expect(isReminderIntent(t)).toBe(true);
    for (const t of ["مرحبا", "كيف حالك؟", "ما هي مهامي", "تذكرت شيئا", ""]) expect(isReminderIntent(t)).toBe(false);
    expect(parseReminderText("مرحبا", NOW).kind).toBe("none");
  });
});

describe("the flagship example", () => {
  it("«ذكرني بكرة الساعة 9 أراجع الفواتير» is ambiguous → asks 9 AM or 9 PM before saving", () => {
    const r = clarify("ذكرني بكرة الساعة 9 أراجع الفواتير");
    expect(r.clarification.reason).toBe("period");
    expect(r.clarification.question).toContain("صباحاً أم مساءً");
    expect(r.draft).toMatchObject({ title: "أراجع الفواتير", date: "2026-11-03", tz: "Asia/Riyadh" });
    expect(r.clarification.options.map((o) => o.patch.time)).toEqual(["09:00", "21:00"]);
    // answering the question yields a saveable reminder at the right Riyadh instant
    const full = completeDraft(r.draft, r.clarification.options[0].patch)!;
    const rem = createReminder(full, NOW, "x");
    expect(rem.dueAt).toBe(riyadh(2026, 11, 3, 9, 0));
    expect(createReminder(completeDraft(r.draft, r.clarification.options[1].patch)!, NOW, "y").dueAt).toBe(riyadh(2026, 11, 3, 21, 0));
  });
  it("with an explicit period it is saved directly", () => {
    expect(ready("ذكرني بكرة الساعة 9 صباحا أراجع الفواتير")).toMatchObject({ title: "أراجع الفواتير", date: "2026-11-03", time: "09:00", repeat: "none" });
    expect(ready("ذكرني بكرة الساعة 9 مساء أراجع الفواتير")).toMatchObject({ date: "2026-11-03", time: "21:00" });
    expect(ready("ذكرني بكرة 9 صباحاً أراجع الفواتير").time).toBe("09:00");
  });
});

describe("times", () => {
  it("Eastern Arabic digits and spelled-out numbers (dictation)", () => {
    expect(ready("ذكرني بكرة الساعة ٩ صباحا أراجع الفواتير").time).toBe("09:00");
    expect(ready("ذكرني بكرة الساعة تسعة صباحا أراجع الفواتير").time).toBe("09:00");
    expect(ready("ذكرني بكرة الساعة تسعة ونص صباحا بالاجتماع").time).toBe("09:30");
    expect(ready("ذكرني بكرة الساعة عشرة وربع مساء بالاجتماع").time).toBe("22:15");
    expect(ready("ذكرني بكرة الساعة 5 إلا ربع مساء بالصلاة").time).toBe("16:45");
    expect(ready("ذكرني بكرة الساعة 9:30 صباحا بالاجتماع").time).toBe("09:30");
    expect(ready("ذكرني بكرة الساعة 12 ظهرا بالغداء").time).toBe("12:00");
    expect(ready("ذكرني بكرة الساعة 2 عصرا بالمكالمة").time).toBe("14:00");
    expect(ready("ذكرني بكرة الساعة 12 صباحا بالمنبه").time).toBe("00:00");
  });
  it("24-hour notation is unambiguous", () => {
    expect(ready("ذكرني بكرة الساعة 21:30 بالاجتماع").time).toBe("21:30");
    expect(ready("ذكرني بكرة الساعة 14:00 بالاجتماع").time).toBe("14:00");
    expect(ready("ذكرني بكرة الساعة 09:00 بالاجتماع").time).toBe("09:00");
    expect(clarify("ذكرني بكرة الساعة 9:30 بالاجتماع").clarification.reason).toBe("period");
  });
  it("«12 مساء» is not guessed", () => {
    expect(clarify("ذكرني بكرة الساعة 12 مساء بالغداء").clarification.reason).toBe("period");
  });
  it("does not mistake numbers in the title for a time", () => {
    const r = clarify("ذكرني بكرة أتصل بـ 3 عملاء");
    expect(r.clarification.reason).toBe("time");
  });
});

describe("relative times (never ambiguous)", () => {
  it("minutes / hours in several spellings", () => {
    expect(ready("ذكرني بعد 30 دقيقة أتصل بأحمد")).toMatchObject({ date: "2026-11-02", time: "02:40", title: "أتصل بأحمد" });
    expect(ready("ذكرني بعد ثلاثين دقيقة أتصل بأحمد").time).toBe("02:40");
    expect(ready("ذكرني بعد ساعتين اشرب الدواء").time).toBe("04:10");
    expect(ready("ذكرني بعد نصف ساعة اشرب الدواء").time).toBe("02:40");
    expect(ready("ذكرني بعد ساعة ونصف اشرب الدواء").time).toBe("03:40");
    expect(ready("ذكرني بعد ربع ساعة اشرب الدواء").time).toBe("02:25");
    expect(ready("ذكرني بعد ٤٥ دقيقة اشرب الدواء").time).toBe("02:55");
    expect(ready("ذكرني بعد ساعة اشرب الدواء").time).toBe("03:10");
    expect(ready("ذكرني بعد 3 ساعات اشرب الدواء").time).toBe("05:10");
  });
  it("crosses midnight correctly", () => {
    const d = ready("ذكرني بعد 23 ساعة اشرب الدواء", riyadh(2026, 11, 2, 23, 0));
    expect(d).toMatchObject({ date: "2026-11-03", time: "22:00" });
  });
  it("days need a time of day", () => {
    expect(clarify("ذكرني بعد يومين أراجع العقد").clarification.reason).toBe("time");
    expect(ready("ذكرني بعد يومين الساعة 10 صباحا أراجع العقد")).toMatchObject({ date: "2026-11-04", time: "10:00" });
    expect(ready("ذكرني بعد غد الساعة 10 صباحا أراجع العقد").date).toBe("2026-11-04");
  });
});

describe("dates", () => {
  it("weekday names resolve to the next such day in Riyadh", () => {
    // 2026-11-02 is Monday → Sunday is 2026-11-08
    expect(ready("ذكرني يوم الأحد الساعة 5 مساء بموعد الطبيب")).toMatchObject({ date: "2026-11-08", time: "17:00", title: "بموعد الطبيب" });
    expect(ready("ذكرني الخميس القادم الساعة 8 صباحا بالتقرير").date).toBe("2026-11-05");
  });
  it("explicit dates, month names, past dates roll to next year", () => {
    expect(ready("ذكرني 15 نوفمبر الساعة 10 صباحا بسداد الإيجار")).toMatchObject({ date: "2026-11-15", time: "10:00" });
    expect(ready("ذكرني 2026-12-01 الساعة 10 صباحا بسداد الإيجار").date).toBe("2026-12-01");
    expect(ready("ذكرني 3/12 الساعة 10 صباحا بسداد الإيجار").date).toBe("2026-12-03");
    const r = parseReminderText("ذكرني 20 يناير الساعة 10 صباحا بالتجديد", NOW);
    expect(r.kind === "ready" && r.draft.date).toBe("2027-01-20");
    expect(r.kind === "ready" && r.notes.join(" ")).toContain("العام القادم");
  });
  it("no date → next occurrence of that clock time", () => {
    expect(ready("ذكرني الساعة 9 صباحا بالاجتماع")).toMatchObject({ date: "2026-11-02", time: "09:00" });
    expect(ready("ذكرني الساعة 1 صباحا بالاجتماع", NOW).date).toBe("2026-11-03"); // 01:00 already passed today
  });
});

describe("recurrence", () => {
  it("daily / weekly / monthly", () => {
    expect(ready("ذكرني كل يوم الساعة 8 صباحا بشرب الدواء")).toMatchObject({ repeat: "daily", time: "08:00", date: "2026-11-02", title: "بشرب الدواء" });
    expect(ready("ذكرني يوميا الساعة 8 مساء بالأذكار")).toMatchObject({ repeat: "daily", time: "20:00" });
    expect(ready("ذكرني كل خميس الساعة 4 عصرا بالتقرير")).toMatchObject({ repeat: "weekly", date: "2026-11-05", time: "16:00" });
    expect(ready("ذكرني كل يوم جمعة الساعة 11 صباحا بالصلاة")).toMatchObject({ repeat: "weekly", date: "2026-11-06" });
    expect(ready("ذكرني كل أسبوع يوم الأحد الساعة 9 صباحا بالاجتماع")).toMatchObject({ repeat: "weekly", date: "2026-11-08" });
    expect(ready("ذكرني كل شهر يوم 25 الساعة 10 صباحا بدفع الإيجار")).toMatchObject({ repeat: "monthly", date: "2026-11-25", time: "10:00" });
  });
  it("monthly day already passed this month → next month", () => {
    expect(ready("ذكرني كل شهر يوم 1 الساعة 10 صباحا بالتقرير").date).toBe("2026-12-01");
  });
});

describe("lead time", () => {
  it("«قبل الموعد بنصف ساعة» / «قبلها بـ 15 دقيقة»", () => {
    expect(ready("ذكرني بكرة الساعة 3 عصرا قبل الموعد بنصف ساعة اجتماع الفريق")).toMatchObject({ leadMinutes: 30, title: "اجتماع الفريق", time: "15:00" });
    expect(ready("ذكرني بكرة الساعة 3 عصرا قبلها بـ15 دقيقة اجتماع الفريق").leadMinutes).toBe(15);
    expect(ready("ذكرني بكرة الساعة 3 عصرا قبل ساعة اجتماع الفريق").leadMinutes).toBe(60);
  });
});

describe("clarifications are asked before saving", () => {
  it("missing time, missing date+time, missing title, past time", () => {
    expect(clarify("ذكرني بكرة أتصل بأحمد").clarification.reason).toBe("time");
    expect(clarify("ذكرني أتصل بأحمد").clarification.reason).toBe("time");
    expect(clarify("ذكرني بكرة الساعة 9 صباحا").clarification.reason).toBe("title");
    const past = clarify("ذكرني اليوم الساعة 1 صباحا أتصل بأحمد");
    expect(past.clarification.reason).toBe("past");
    expect(past.clarification.options[0].patch.date).toBe("2026-11-03");
  });
  it("«today at 9» in the afternoon has only one future reading → resolved (and noted)", () => {
    const r = parseReminderText("ذكرني اليوم الساعة 9 أراجع الفواتير", AFTERNOON);
    expect(r.kind).toBe("ready");
    expect(r.kind === "ready" && r.draft).toMatchObject({ date: "2026-11-02", time: "21:00" });
    // but at 02:10 both 09:00 and 21:00 are ahead → ask
    expect(clarify("ذكرني اليوم الساعة 9 أراجع الفواتير").clarification.reason).toBe("period");
  });
  it("completeDraft refuses incomplete drafts", () => {
    expect(completeDraft({ title: "x" })).toBeNull();
    expect(completeDraft({ title: "x", date: "2026-11-03" }, { time: "09:00" })).toMatchObject({ time: "09:00" });
  });
});

describe("priority hint", () => {
  it("«مهم/عاجل» raises priority", () => {
    expect(ready("ذكرني بكرة الساعة 9 صباحا موعد مهم مع المحاسب").priority).toBe("high");
    expect(ready("ذكرني بكرة الساعة 9 صباحا موعد المحاسب").priority).toBe("normal");
  });
});
