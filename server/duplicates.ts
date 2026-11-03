/**
 * Dubletten erkennen: dieselbe Pressemitteilung in mehreren Postfächern. Agenturen verschicken sie
 * meist einzeln an jede Adresse – mit eigener Message-ID, eigenen Klick-Zählern und persönlicher
 * Anrede. Verglichen wird deshalb der Text (ohne Links) und der Betreff.
 */

import type { PressMail } from "./mail.ts";

export interface Fingerprint {
  messageId: string;
  /** Betreff ohne „AW:“, „[Presse]“, Satzzeichen und Groß-/Kleinschreibung */
  subjectKey: string;
  /** die kleinsten Hashwerte der Wortgruppen des Textes (Bottom-k-Sketch) */
  sketch: number[];
}

const SKETCH_SIZE = 64;
const SHINGLE_WORDS = 4;
/** gleicher Betreff und so ähnlicher Text → dieselbe Mail (Anrede, Fußzeile und Links dürfen abweichen) */
const SAME_SUBJECT_SIMILARITY = 0.35;
/**
 * Auch mit anderem Betreff dieselbe Mail, wenn der Text fast gleich ist (z. B. Label und Agentur) –
 * aber nur, wenn die Betreffe mindestens zwei Stichworte teilen (meist Band und Album). Sonst würden
 * Newsletter mit gleicher Vorlage (Shop-Werbung, Fußzeilen) zusammengeworfen.
 */
const TEXT_SIMILARITY = 0.75;
const MIN_SHARED_SUBJECT_WORDS = 2;

/** Füllwörter, die in Betreffen nichts über den Inhalt sagen */
const STOPWORDS = new Set(
  ("der die das und mit für von auf aus im in am an zu zum zur ein eine neue neuer neues neu nur statt ohne jetzt " +
    "the a an and of to in on at for with by from new out now feat ft promo album single video tour release official").split(" "),
);

const subjectWords = (key: string) => new Set(key.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w)));

const PREFIX = /^\s*((re|aw|fw|fwd|wg|wtr|sv|tr)\s*:\s*|\[[^\]]*\]\s*|(presseinfo|presseinformation|pressemitteilung|pressemeldung|press release|news|pm)\s*[:|–-]\s*)/i;

export function subjectKey(subject: string): string {
  let s = subject;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(PREFIX, "");
  }
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** FNV-1a, 32 Bit – schnell und für diesen Zweck gut genug verteilt */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sketch(text: string): number[] {
  const words = text
    .replace(/https?:\/\/\S+|\S+@\S+\.\w+/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
  const hashes = new Set<number>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) hashes.add(hash(words.slice(i, i + SHINGLE_WORDS).join(" ")));
  return [...hashes].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

/** Geschätzte Jaccard-Ähnlichkeit zweier Texte (0…1) aus ihren Sketches. */
export function similarity(a: number[], b: number[]): number {
  // zu wenig Text für eine verlässliche Aussage
  if (Math.min(a.length, b.length) < 5) return 0;
  const inA = new Set(a);
  const inB = new Set(b);
  // die k kleinsten Werte der Vereinigung sind eine Zufallsstichprobe – Anteil, der in beiden vorkommt
  const sample = [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, Math.min(a.length, b.length));
  return sample.filter((h) => inA.has(h) && inB.has(h)).length / sample.length;
}

export function fingerprint(mail: Pick<PressMail, "messageId" | "subject" | "body">): Fingerprint {
  return { messageId: mail.messageId, subjectKey: subjectKey(mail.subject), sketch: sketch(mail.body) };
}

export function isDuplicate(a: Fingerprint, b: Fingerprint): boolean {
  if (a.messageId === b.messageId) return true;
  const sim = similarity(a.sketch, b.sketch);
  if (a.subjectKey.length >= 6 && a.subjectKey === b.subjectKey && sim >= SAME_SUBJECT_SIMILARITY) return true;
  if (sim < TEXT_SIMILARITY) return false;
  const wordsB = subjectWords(b.subjectKey);
  return [...subjectWords(a.subjectKey)].filter((w) => wordsB.has(w)).length >= MIN_SHARED_SUBJECT_WORDS;
}

export interface MailGroup<T> {
  mail: T;
  duplicates: T[];
}

/**
 * Gleiche Mails zusammenfassen. Hauptmail einer Gruppe ist die mit Entwurf (`prefer`),
 * sonst die zuerst eingegangene. Reihenfolge der Gruppen wie in `mails`.
 */
export function groupDuplicates<T extends Pick<PressMail, "messageId" | "subject" | "body" | "date">>(
  mails: T[],
  prefer: (mail: T) => boolean = () => false,
): MailGroup<T>[] {
  const prints = mails.map(fingerprint);
  const groupOf: number[] = mails.map((_, i) => i);
  const root = (i: number): number => (groupOf[i] === i ? i : (groupOf[i] = root(groupOf[i]!)));
  for (let i = 0; i < mails.length; i++) {
    for (let j = i + 1; j < mails.length; j++) {
      if (isDuplicate(prints[i]!, prints[j]!)) groupOf[root(j)] = root(i);
    }
  }

  const members = new Map<number, T[]>();
  mails.forEach((m, i) => members.set(root(i), [...(members.get(root(i)) ?? []), m]));
  const groups: MailGroup<T>[] = [];
  const seen = new Set<number>();
  mails.forEach((_, i) => {
    const r = root(i);
    if (seen.has(r)) return;
    seen.add(r);
    const all = members.get(r)!;
    const main = all.find(prefer) ?? [...all].sort((a, b) => a.date.localeCompare(b.date))[0]!;
    groups.push({ mail: main, duplicates: all.filter((m) => m !== main) });
  });
  return groups;
}
