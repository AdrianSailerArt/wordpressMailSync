/** Prüfhilfe im Browser: Links und Text aus dem Beitrags-HTML (braucht DOMParser). */

export { compareDates, findDates, type DateCheck, type FoundDate } from "./dates";

const normalizeUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/[/#?]+$/, "").toLowerCase();

/** Links des Beitrags, die so nicht in der Mail vorkommen. */
export function foreignLinks(articleHtml: string, mailUrls: string[], mailText: string): { url: string; label: string }[] {
  const known = new Set(mailUrls.map(normalizeUrl));
  const text = mailText.toLowerCase();
  const doc = new DOMParser().parseFromString(articleHtml, "text/html");
  return [...doc.querySelectorAll("a[href]")]
    .map((a) => ({ url: a.getAttribute("href")!, label: a.textContent?.trim() ?? "" }))
    .filter((l) => !known.has(normalizeUrl(l.url)) && !text.includes(normalizeUrl(l.url)));
}

/** Beitrags-HTML als Fließtext (Absätze und Listenpunkte als Zeilen). */
export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("p, h2, h3, li, tr, blockquote").forEach((el) => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
