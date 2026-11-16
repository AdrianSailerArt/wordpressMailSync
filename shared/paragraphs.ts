/**
 * Stellen im Beitrags-HTML, an denen Bilder und Videos stehen können – „nach Absatz n“.
 * Gemeinsam für Server (Veröffentlichen) und Dashboard (Vorschau, Positionsauswahl).
 */

/** Etwas nach dem n-ten Absatz einfügen; 0 = ganz am Anfang */
export type ParagraphInsert = { after: number; html: string };

/** Ende jedes Absatzes (Index hinter `</p>`) */
const paragraphEnds = (html: string): number[] => {
  const ends: number[] = [];
  for (let i = html.indexOf("</p>"); i !== -1; i = html.indexOf("</p>", i + 4)) ends.push(i + 4);
  return ends;
};

/** Text der Absätze, gekürzt – für die Auswahl „nach Absatz 2: „…““ */
export const paragraphSnippets = (html: string, max = 60): string[] =>
  [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => {
    const text = m[1]!.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  });

/**
 * Mehrere Einfügungen auf einmal, alle bezogen auf die Absätze des ursprünglichen HTML.
 * Gibt es weniger Absätze als verlangt, kommt es hinter den letzten, ohne Absätze ans Ende.
 * Mehrere an derselben Stelle bleiben in der übergebenen Reihenfolge.
 */
export const insertAtParagraphs = (html: string, inserts: ParagraphInsert[]): string => {
  if (!inserts.length) return html;
  const ends = paragraphEnds(html);
  const offsetOf = (after: number) => {
    if (after <= 0) return 0;
    return ends.length ? ends[Math.min(after, ends.length) - 1]! : html.length;
  };
  const groups = new Map<number, string[]>();
  for (const ins of inserts) {
    const at = offsetOf(ins.after);
    groups.set(at, [...(groups.get(at) ?? []), ins.html]);
  }
  let out = "";
  let last = 0;
  for (const at of [...groups.keys()].sort((a, b) => a - b)) {
    const block = groups.get(at)!.join("\n");
    const before = html.slice(last, at);
    // ohne Absätze hängt es nur hinten an; sonst steht der Block zwischen Zeilenumbrüchen
    out += at === 0 ? `${block}\n` : `${before}\n${block}${ends.length ? "\n" : ""}`;
    last = at;
  }
  return out + html.slice(last);
};
