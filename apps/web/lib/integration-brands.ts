import type { IconName } from "@/components/icon";

/**
 * Brand layer for integrations: integration id -> logo + colours.
 * Add a service by adding one entry here (and, for multi-colour artwork, one SVG under public/integrations/).
 * Sources and licences: docs/INTEGRATION_BRAND_ASSETS.md.
 */
export type BrandMark =
  /** Single-path official glyph (simple-icons, CC0) painted with the brand colour, so it follows light/dark. */
  | { kind: "glyph"; viewBox: string; path: string; color: { light: string; dark: string } }
  /** Official multi-colour artwork shipped as a local SVG; always shown on a light tile so it stays legible. */
  | { kind: "image"; src: string };

export type IntegrationBrand = { id: string; mark: BrandMark };

const glyph = (path: string, light: string, dark: string): BrandMark => ({ kind: "glyph", viewBox: "0 0 24 24", path, color: { light, dark } });

export const INTEGRATION_BRANDS: Record<string, IntegrationBrand> = {
  github: { id: "github", mark: glyph("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12", "#181717", "#ffffff") },
  vercel: { id: "vercel", mark: glyph("m12 1.608 12 20.784H0Z", "#000000", "#ffffff") },
  railway: { id: "railway", mark: glyph("M.113 10.27A13.026 13.026 0 000 11.48h18.23c-.064-.125-.15-.237-.235-.347-3.117-4.027-4.793-3.677-7.19-3.78-.8-.034-1.34-.048-4.524-.048-1.704 0-3.555.005-5.358.01-.234.63-.459 1.24-.567 1.737h9.342v1.216H.113v.002zm18.26 2.426H.009c.02.326.05.645.094.961h16.955c.754 0 1.179-.429 1.315-.96zm-17.318 4.28s2.81 6.902 10.93 7.024c4.855 0 9.027-2.883 10.92-7.024H1.056zM11.988 0C7.5 0 3.593 2.466 1.531 6.108l4.75-.005v-.002c3.71 0 3.849.016 4.573.047l.448.016c1.563.052 3.485.22 4.996 1.364.82.621 2.007 1.99 2.712 2.965.654.902.842 1.94.396 2.934-.408.914-1.289 1.458-2.353 1.458H.391s.099.42.249.886h22.748A12.026 12.026 0 0024 12.005C24 5.377 18.621 0 11.988 0z", "#0b0d0e", "#ffffff") },
  gmail: { id: "gmail", mark: { kind: "image", src: "/integrations/gmail.svg" } },
  google_drive: { id: "google_drive", mark: { kind: "image", src: "/integrations/google-drive.svg" } },
  google_calendar: { id: "google_calendar", mark: { kind: "image", src: "/integrations/google-calendar.svg" } },
};

/** Services with no public brand artwork we can legitimately ship get a neutral app icon instead of an invented logo. */
export const NEUTRAL_ICONS: Record<string, IconName> = { windows_worker: "server" };

export const brandFor = (id: string): IntegrationBrand | undefined => INTEGRATION_BRANDS[id];
