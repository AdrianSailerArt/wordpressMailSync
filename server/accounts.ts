/**
 * Postfächer im Dashboard pflegen statt in der .env: gespeichert in der lokalen Datenbank.
 * Beim ersten Start werden IMAP_*-Einträge aus der .env einmal übernommen.
 *
 * Jedes Postfach hat eine feste Nummer `nr`. Sie steckt in den Mail-IDs (siehe mailId) und wird nie
 * neu vergeben – so zeigen Entwürfe und Verlauf auch nach Löschen oder Umsortieren aufs richtige Postfach.
 */

import { resolveMx, resolveSrv } from "node:dns/promises";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import type { ImapAccount } from "./config.ts";
import type { Store } from "./db.ts";

export type MailAccount = ImapAccount & { nr: number };
/** fürs Dashboard: ohne Passwort */
export type PublicAccount = Omit<MailAccount, "password"> & { hasPassword: boolean };

const SETTING = "mail_accounts";

export const AccountInput = z.object({
  name: z.string().trim().default(""),
  user: z.string().trim().min(1, "Benutzer bzw. Mail-Adresse fehlt"),
  /** leer beim Bearbeiten: altes Passwort behalten */
  password: z.string().default(""),
  host: z.string().trim().min(1, "IMAP-Server fehlt"),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  folder: z.string().trim().default("INBOX"),
  processedFolder: z.string().trim().default(""),
});
export type AccountInput = z.input<typeof AccountInput>;

function parse(input: AccountInput) {
  const r = AccountInput.safeParse(input);
  if (!r.success) throw new Error(r.error.issues.map((i) => i.message).join(" · "));
  return { ...r.data, name: r.data.name || r.data.user, folder: r.data.folder || "INBOX" };
}

export const toPublic = ({ password, ...a }: MailAccount): PublicAccount => ({ ...a, hasPassword: !!password });

/** gespeicherte Postfächer – beim allerersten Mal die aus der .env übernehmen (Nummern wie bisher) */
export function loadAccounts(store: Store, fromEnv: ImapAccount[]): MailAccount[] {
  const stored = store.getSetting(SETTING);
  if (stored) return JSON.parse(stored) as MailAccount[];
  const imported = fromEnv.map((a, nr) => ({ ...a, nr }));
  if (imported.length) saveAccounts(store, imported);
  return imported;
}

export const saveAccounts = (store: Store, accounts: MailAccount[]) => store.setSetting(SETTING, JSON.stringify(accounts));

/** Nummern gelöschter Postfächer bleiben gesperrt, damit alte Mail-IDs nie auf ein neues Postfach zeigen */
function nextNr(store: Store, accounts: MailAccount[]): number {
  const used = Number(store.getSetting(`${SETTING}_next`) ?? 0);
  return Math.max(used, ...accounts.map((a) => a.nr + 1));
}

export function addAccount(store: Store, accounts: MailAccount[], input: AccountInput): MailAccount[] {
  const data = parse(input);
  if (!data.password) throw new Error("Passwort fehlt");
  if (accounts.some((a) => a.user.toLowerCase() === data.user.toLowerCase() && a.host.toLowerCase() === data.host.toLowerCase()))
    throw new Error(`${data.user} ist schon eingerichtet`);
  const nr = nextNr(store, accounts);
  store.setSetting(`${SETTING}_next`, String(nr + 1));
  return [...accounts, { ...data, nr }];
}

export function updateAccount(accounts: MailAccount[], nr: number, input: AccountInput): MailAccount[] {
  const old = accounts.find((a) => a.nr === nr);
  if (!old) throw new Error("Dieses Postfach gibt es nicht");
  const data = parse(input);
  // anderer Server oder Benutzer: das alte Passwort gehört nicht dazu
  const same = data.host.toLowerCase() === old.host.toLowerCase() && data.user.toLowerCase() === old.user.toLowerCase();
  if (!data.password && !same) throw new Error("Für einen anderen Server oder Benutzer das Passwort neu eingeben");
  return accounts.map((a) => (a.nr === nr ? { ...data, password: data.password || old.password, nr } : a));
}

export function removeAccount(store: Store, accounts: MailAccount[], nr: number): MailAccount[] {
  if (!accounts.some((a) => a.nr === nr)) throw new Error("Dieses Postfach gibt es nicht");
  store.setSetting(`${SETTING}_next`, String(nextNr(store, accounts)));
  return accounts.filter((a) => a.nr !== nr);
}

// ---- IMAP-Server erkennen

/** bekannte Anbieter: Domain → IMAP-Server */
const PROVIDERS: [RegExp, string][] = [
  [/^(gmail|googlemail)\.com$/, "imap.gmail.com"],
  [/^(gmx\.(de|net|at|ch)|gmx\.com)$/, "imap.gmx.net"],
  [/^web\.de$/, "imap.web.de"],
  [/^(outlook|hotmail|live|msn)\.(com|de)$/, "outlook.office365.com"],
  [/^(icloud|me|mac)\.com$/, "imap.mail.me.com"],
  [/^t-online\.de$/, "secureimap.t-online.de"],
  [/^(yahoo|ymail)\.(com|de)$/, "imap.mail.yahoo.com"],
  [/^posteo\.(de|net)$/, "posteo.de"],
  [/^mailbox\.org$/, "imap.mailbox.org"],
  [/^(freenet|mail)\.de$/, "mx.freenet.de"],
];

/** Wer die Mails einer eigenen Domain hostet, verrät der MX-Eintrag */
const BY_MX: [RegExp, string][] = [
  [/google(mail)?\.com\.?$/i, "imap.gmail.com"],
  [/outlook\.com\.?$/i, "outlook.office365.com"],
  [/(ionos|1and1|kundenserver|schlund)\./i, "imap.ionos.de"],
  [/strato\./i, "imap.strato.de"],
  [/(hosteurope|webpack)\./i, "imap.hosteurope.de"],
  [/all-inkl\.com\.?$/i, "imap.all-inkl.com"],
  [/zoho\./i, "imap.zoho.eu"],
  [/icloud\.com\.?$/i, "imap.mail.me.com"],
];

export interface ServerGuess {
  host: string;
  port: number;
  /** woher der Vorschlag kommt – fürs Dashboard */
  quelle: "Anbieter" | "DNS-Eintrag" | "MX-Eintrag" | "Vermutung";
}

/** IMAP-Server zur Mail-Adresse: bekannte Anbieter, dann DNS (SRV, MX), sonst imap.<domain> */
export async function guessServer(email: string): Promise<ServerGuess | null> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain || !domain.includes(".")) return null;
  const known = PROVIDERS.find(([re]) => re.test(domain));
  if (known) return { host: known[1], port: 993, quelle: "Anbieter" };
  const srv = await resolveSrv(`_imaps._tcp.${domain}`).catch(() => []);
  const best = srv.filter((r) => r.name && r.name !== ".").sort((a, b) => a.priority - b.priority)[0];
  if (best) return { host: best.name.replace(/\.$/, ""), port: best.port || 993, quelle: "DNS-Eintrag" };
  const mx = await resolveMx(domain).catch(() => []);
  for (const r of mx.sort((a, b) => a.priority - b.priority)) {
    const hit = BY_MX.find(([re]) => re.test(r.exchange));
    if (hit) return { host: hit[1], port: 993, quelle: "MX-Eintrag" };
  }
  return { host: `imap.${domain}`, port: 993, quelle: "Vermutung" };
}

export interface ConnectionTest {
  ok: boolean;
  error?: string;
  /** alle Ordner – für die Auswahl im Dashboard */
  folders: string[];
  /** Mails im gewählten Ordner */
  messages?: number;
}

/** Anmelden, Ordner auflisten, gewählten Ordner prüfen – verändert nichts im Postfach */
export async function testConnection(a: Pick<ImapAccount, "host" | "port" | "user" | "password" | "folder">): Promise<ConnectionTest> {
  const client = new ImapFlow({
    host: a.host, port: a.port, secure: a.port !== 143,
    auth: { user: a.user, pass: a.password }, logger: false,
    connectionTimeout: 15_000, greetingTimeout: 10_000,
  });
  try {
    await client.connect();
    const folders = (await client.list()).map((f) => f.path).sort((x, y) => (x === "INBOX" ? -1 : y === "INBOX" ? 1 : x.localeCompare(y, "de")));
    if (!folders.includes(a.folder)) return { ok: false, folders, error: `Ordner „${a.folder}“ gibt es in diesem Postfach nicht` };
    const status = await client.status(a.folder, { messages: true });
    return { ok: true, folders, messages: status ? status.messages : undefined };
  } catch (e) {
    const err = e as Error & { authenticationFailed?: boolean; responseText?: string; code?: string };
    const error = err.authenticationFailed
      ? "Anmeldung abgelehnt – Benutzer oder Passwort stimmt nicht (bei Gmail, iCloud & Co. ein App-Passwort nehmen)"
      : err.code === "ENOTFOUND" ? `Server ${a.host} nicht gefunden`
      : err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || /timeout/i.test(err.message) ? `Keine Verbindung zu ${a.host}:${a.port}`
      : err.responseText || err.message;
    return { ok: false, folders: [], error };
  } finally {
    await client.logout().catch(() => client.close());
  }
}
