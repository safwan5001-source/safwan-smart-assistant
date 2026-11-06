/**
 * BASHT | باشت — brand constants. One place for every visible product name and official asset path.
 * Assets are generated from the owner-supplied official logo by scripts/generate-brand-assets.py (crop/resize only, never redrawn).
 * Storage keys and internal ids keep their historical `safwan-*` names on purpose (renaming them would orphan saved data).
 */
export const BRAND = {
  nameAr: "باشت",
  nameEn: "BASHT",
  /** Full lockup used for titles: «باشت | BASHT» */
  full: "باشت | BASHT",
  tagline: "وكيل ذكاء اصطناعي",
  description: "باشت — وكيلك التنفيذي الذكي: محادثات ومهام وتذكيرات وملفات في مركز قيادة واحد.",
  /** The person the product serves. Greetings use this; it is not the product name. */
  ownerName: "صفوان",
} as const;

export const BRAND_ASSETS = {
  logo: "/brand/basht-logo.webp",
  mark: "/brand/basht-mark.webp",
  markSm: "/brand/basht-mark-sm.webp",
  wordmark: "/brand/basht-wordmark.webp",
  wordmarkWhite: "/brand/basht-wordmark-white.webp",
  appleTouch: "/icons/apple-touch-icon.png",
} as const;

/** Native-pixel launch screens: [width, height, css width, css height, dpr]. Must match SPLASH_SIZES in the generator. */
export const SPLASH: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [1206, 2622, 402, 874, 3], // iPhone 16 Pro
  [1320, 2868, 440, 956, 3], // iPhone 16 Pro Max
  [1179, 2556, 393, 852, 3], // iPhone 15 / 15 Pro / 16
  [1290, 2796, 430, 932, 3], // iPhone 15 Plus / Pro Max / 16 Plus
  [1170, 2532, 390, 844, 3], // iPhone 12 – 14
  [1284, 2778, 428, 926, 3], // iPhone 12/13 Pro Max, 14 Plus
  [1125, 2436, 375, 812, 3], // iPhone X / XS / 11 Pro / mini
  [828, 1792, 414, 896, 2], // iPhone XR / 11
  [750, 1334, 375, 667, 2], // iPhone SE / 8
];

export const splashImages = () =>
  SPLASH.flatMap(([w, h, cw, ch, dpr]) => (["light", "dark"] as const).map((scheme) => ({
    url: `/icons/splash/apple-splash-${w}x${h}${scheme === "dark" ? "-dark" : ""}.png`,
    media: `(device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})`,
  })));
