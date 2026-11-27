import "server-only";
/**
 * A short, human name for the device a session is opened on ("آيفون · Safari"), from the User-Agent. Display only: it helps the
 * owner tell sessions apart in «الدخول والأمان» and is never used for any security decision (a User-Agent can say anything).
 */
const DEVICES: [RegExp, string][] = [
  [/iPad/, "آيباد"], [/iPhone|iPod/, "آيفون"], [/Android/, "أندرويد"], [/CrOS/, "كروم بوك"],
  [/Macintosh|Mac OS X/, "ماك"], [/Windows/, "ويندوز"], [/Linux/, "لينكس"],
];
const BROWSERS: [RegExp, string][] = [
  [/EdgiOS|EdgA|Edg\//, "Edge"], [/SamsungBrowser/, "Samsung Internet"], [/FxiOS|Firefox\//, "Firefox"],
  [/OPR\/|OPiOS/, "Opera"], [/CriOS|Chrome\//, "Chrome"], [/Safari\//, "Safari"],
];
export function deviceLabel(ua: string | null | undefined): string {
  const s = (ua ?? "").slice(0, 512);
  const device = DEVICES.find(([re]) => re.test(s))?.[1] ?? "جهاز";
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1];
  return browser ? `${device} · ${browser}` : device;
}
