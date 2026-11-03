/** Prüfhilfe: Termine aus Mail und Beitrag herausziehen, damit Abweichungen auffallen. */

const MONTHS: Record<string, number> = {
  januar: 1, jänner: 1, january: 1, jan: 1, februar: 2, february: 2, feb: 2, märz: 3, maerz: 3, march: 3, mär: 3, mar: 3,
  april: 4, apr: 4, mai: 5, may: 5, juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10, november: 11, nov: 11, dezember: 12, december: 12, dez: 12, dec: 12,
};
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

export interface FoundDate {
  /** Tag.Monat – darüber wird verglichen */
  key: string;
  year?: number;
  /** so stand es im Text */
  text: string;
}

const fullYear = (y?: string) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : undefined);
const pad = (n: number) => String(n).padStart(2, "0");

/** Alle Datumsangaben: 12.03.2027, 12.3., 12. März 2027, March 12th, 2027, 12 March … */
export function findDates(text: string): FoundDate[] {
  const out = new Map<string, FoundDate & { at: number }>();
  const add = (d: number, m: number, y: string | undefined, raw: string, at: number) => {
    if (d < 1 || d > 31 || m < 1 || m > 12) return;
    const year = fullYear(y);
    const key = `${pad(d)}.${pad(m)}.`;
    const id = `${key}${year ?? ""}`;
    if (!out.has(id)) out.set(id, { key, year, text: raw.trim(), at });
  };
  // Zahlenformat; die Lookbehind/-ahead verhindern Treffer in Uhrzeiten, Preisen und Versionsnummern
  for (const m of text.matchAll(/(?<![\d.,:])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2}(?!\d))?(?![\d,])/g)) add(+m[1]!, +m[2]!, m[3], m[0], m.index);
  for (const m of text.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s+(${MONTH})\\.?(?![a-zä])(?:,?\\s+(\\d{4}))?`, "gi"))) {
    add(+m[1]!, MONTHS[m[2]!.toLowerCase()]!, m[3], m[0], m.index);
  }
  for (const m of text.matchAll(new RegExp(`(?<![a-zä])(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?`, "gi"))) {
    add(+m[2]!, MONTHS[m[1]!.toLowerCase()]!, m[3], m[0], m.index);
  }
  // in Lesereihenfolge
  return [...out.values()].sort((a, b) => a.at - b.at).map(({ at: _, ...d }) => d);
}

export interface DateCheck {
  date: FoundDate;
  /** steht so auch auf der anderen Seite */
  match: "ok" | "missing" | "year";
}

/**
 * Termine abgleichen: was in der Mail steht und im Beitrag fehlt, und – wichtiger –
 * was im Beitrag steht, aber nicht in der Mail (möglicherweise vom Modell erfunden).
 */
export function compareDates(mailText: string, articleText: string): { fromMail: DateCheck[]; onlyArticle: FoundDate[] } {
  const mail = findDates(mailText);
  const article = findDates(articleText);
  const check = (d: FoundDate, other: FoundDate[]): DateCheck["match"] => {
    const same = other.filter((o) => o.key === d.key);
    if (!same.length) return "missing";
    return d.year && same.every((o) => o.year && o.year !== d.year) ? "year" : "ok";
  };
  return {
    fromMail: mail.map((date) => ({ date, match: check(date, article) })),
    onlyArticle: article.filter((d) => check(d, mail) !== "ok"),
  };
}
