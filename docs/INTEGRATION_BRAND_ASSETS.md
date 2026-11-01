# Integration brand assets

Logos shown in the Integrations screen and global search. Mapping lives in `apps/web/lib/integration-brands.ts`;
rendering in `apps/web/components/integration-logo.tsx`.

| Integration | Artwork | Source | Licence of the file |
|---|---|---|---|
| GitHub | mono glyph, inline path | simple-icons 16.36.0 `github` | CC0-1.0 |
| Vercel | mono glyph, inline path | simple-icons 16.36.0 `vercel` | CC0-1.0 |
| Railway | mono glyph, inline path | simple-icons 16.36.0 `railway` | CC0-1.0 |
| Gmail | multi-colour, `public/integrations/gmail.svg` | Wikimedia Commons, "Gmail icon (2020).svg" | Public domain (marked *trademarked*) |
| Google Drive | multi-colour, `public/integrations/google-drive.svg` | Wikimedia Commons, "Google Drive icon (2020).svg" | Public domain (marked *trademarked*) |
| Google Calendar | multi-colour, `public/integrations/google-calendar.svg` | Wikimedia Commons, "Google Calendar icon (2020).svg" | Public domain (marked *trademarked*) |

- The SVG files are free to redistribute, but the marks remain trademarks of GitHub, Vercel, Railway and Google.
  They are used only to identify the service the user connects, as nominative use; they imply no endorsement.
  Check each vendor's brand guidelines before using them in marketing material.
- Mono glyphs are painted with the brand colour in light mode and white in dark mode. Multi-colour logos always sit on a
  white tile so they stay legible in both themes.
- Services without public artwork (Daftra, Windows cloud worker) intentionally get a neutral icon / monogram, not an invented logo.
- If an image fails to load, the tile falls back to the monogram.
- To add a service: add an entry to `INTEGRATION_BRANDS` (glyph path from simple-icons, or an SVG in `public/integrations/`).
