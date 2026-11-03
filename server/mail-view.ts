/** Original-Mail für das Dashboard: HTML entschärfen, damit sie so aussieht wie im Mailprogramm – ohne Skripte. */

import sanitizeHtml from "sanitize-html";
import type { PressMail } from "./mail.ts";
import { isBlockedLink } from "./rewrite.ts";

export interface MailLink {
  url: string;
  label: string;
  /** dürfte nicht in den Artikel (Download, Presseordner, Hörprobe …) */
  blocked: boolean;
}

export interface OriginalMail {
  subject: string;
  sender: string;
  to: string;
  date: string;
  body: string;
  hasHtml: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
  links: MailLink[];
}

/** Abmelde-, Profil- und Browser-Ansicht-Links sind für die Prüfung uninteressant. */
const BORING_LINK = /unsubscribe|abmelden|abbestellen|newsletter.*(profil|settings)|view.*(browser|online)|im browser|webversion|mailto:/i;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Alle Links der Mail mit Linktext – doppelte Ziele nur einmal. */
export function mailLinks(mail: Pick<PressMail, "html" | "body">): MailLink[] {
  const links = new Map<string, MailLink>();
  const add = (url: string, label: string) => {
    if (links.has(url) || BORING_LINK.test(url) || BORING_LINK.test(label)) return;
    links.set(url, { url, label: label || url, blocked: isBlockedLink(url, label) });
  };
  if (mail.html) {
    for (const [, href, inner] of mail.html.matchAll(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      add(href!.replace(/&amp;/g, "&"), text(inner!).slice(0, 120));
    }
  } else {
    for (const [url] of mail.body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) add(url, "");
  }
  return [...links.values()].slice(0, 60);
}

export function originalMail(mail: PressMail): OriginalMail {
  return {
    subject: mail.subject,
    sender: mail.sender,
    to: mail.to ?? "",
    date: mail.date,
    body: mail.body,
    hasHtml: !!mail.html,
    attachments: mail.attachments ?? [],
    links: mailLinks(mail),
  };
}

/**
 * Mail-HTML als eigenständige Seite. Skripte, Formulare und Tracking-Attribute fliegen raus,
 * eingebettete Bilder (cid:) werden direkt eingesetzt. Externe Bilder lädt der Browser nur,
 * wenn `remoteImages` gesetzt ist. Die Content-Security-Policy steht im Dokument selbst,
 * damit sie auch greift, wenn das Dashboard die Seite per srcdoc einsetzt.
 */
export function renderMailHtml(mail: PressMail, remoteImages = false): string {
  const cids = new Map(mail.images.filter((i) => i.cid).map((i) => [i.cid!, `data:${i.contentType};base64,${i.data.toString("base64")}`]));
  const safe = sanitizeHtml(mail.html ?? "", {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "center", "font", "span", "style", "u", "s"]),
    allowedAttributes: {
      "*": ["style", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "class"],
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "style"],
      font: ["face", "size", "color"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowVulnerableTags: true, // <style> der Mail behalten – Skripte sind trotzdem raus, CSP blockt den Rest
    transformTags: {
      a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
      img: (tag, attribs) => {
        const src = attribs.src?.startsWith("cid:") ? cids.get(attribs.src.slice(4).replace(/^<|>$/g, "")) : attribs.src;
        return { tagName: tag, attribs: { ...attribs, src: src ?? "" } };
      },
    },
  });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${mailCsp(remoteImages)}">
<style>
  html { background: #fff; color: #18181b; }
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, system-ui, sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  img:not([src^="data:"]) { background: repeating-linear-gradient(45deg, #f4f4f5 0 8px, #e4e4e7 8px 16px); min-height: 24px; }
  table { max-width: 100% !important; }
</style></head><body>${safe}</body></html>`;
}

/** Strenge Richtlinie für die Mail-Seite: kein Skript, keine Formulare, externe Bilder nur auf Wunsch. */
export function mailCsp(remoteImages: boolean): string {
  return [
    "default-src 'none'",
    `img-src data:${remoteImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}
