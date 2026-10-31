/** Arabic-aware matching: ignores diacritics/tatweel and unifies alef, ya, ta-marbuta, case. */
export function normalizeAr(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLocaleLowerCase()
    .trim();
}

/** Every whitespace-separated term of the query must appear in the haystack. */
export function matches(haystack: string, query: string): boolean {
  const terms = normalizeAr(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const h = normalizeAr(haystack);
  return terms.every((t) => h.includes(t));
}
