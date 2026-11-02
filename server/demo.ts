/** Demo-Modus (DEMO=1): Beispiel-Mails und ein simuliertes WordPress, kein Netzwerkzugriff. */

import type { Store } from "./db.ts";
import type { PressMail } from "./mail.ts";
import type { Deps } from "./pipeline.ts";
import { cleanArticle, type Article } from "./rewrite.ts";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const MAILS: PressMail[] = [
  {
    uid: 101, subject: "PRESSEINFO: Nordlicht Kollektiv – „Weite“ Tour 2027", sender: "Lena Krause <presse@sternklang-promo.de>", date: hoursAgo(2), images: [],
    body: "Das Berliner Indie-Quintett Nordlicht Kollektiv geht im Frühjahr 2027 mit seinem dritten Album „Weite“ auf Tour.\n\n12.03.2027 Hamburg – Uebel & Gefährlich\n14.03.2027 Köln – Gloria\n15.03.2027 München – Technikum\n18.03.2027 Wien – Flex\n\nTickets ab 32 € gibt es ab Freitag, 10 Uhr, unter https://tickets.example.com/nordlicht.\n\nFoto: Jana Weiss",
  },
  {
    uid: 102, subject: "Neue Single: Mira Sol – „Glas“ (VÖ 14.11.)", sender: "Label Kontor <promo@labelkontor.example>", date: hoursAgo(20), images: [],
    body: "Mira Sol veröffentlicht am 14. November ihre neue Single „Glas“, die erste Auskopplung aus dem kommenden Album. Das Video feiert am selben Tag Premiere auf YouTube.",
  },
  {
    uid: 103, subject: "Ihre Rechnung Nr. 2026-1188", sender: "Hosting GmbH <billing@hosting.example>", date: hoursAgo(30), images: [],
    body: "Sehr geehrter Kunde, anbei Ihre Rechnung für November.",
  },
];

function fakeArticle(mail: PressMail): Article {
  const tour = mail.uid === 101;
  return cleanArticle({
    relevant: true,
    reason: "Demo",
    title: tour ? "Nordlicht Kollektiv: „Weite“ Tour 2027 – alle Termine" : "Mira Sol: Neue Single „Glas“ erscheint am 14.11.",
    slug: tour ? "nordlicht-kollektiv-weite-tour-2027" : "mira-sol-single-glas",
    focus_keyword: tour ? "Nordlicht Kollektiv Tour 2027" : "Mira Sol Glas",
    meta_description: tour
      ? "Nordlicht Kollektiv kommt 2027 mit „Weite“ auf Tour: alle Termine in Hamburg, Köln, München und Wien – jetzt Tickets sichern!"
      : "Mira Sol meldet sich mit „Glas“ zurück: Die neue Single samt Video erscheint am 14. November. Alle Infos zum kommenden Album.",
    excerpt: tour ? "Vier Städte, ein neues Album: Nordlicht Kollektiv gehen im März 2027 auf Tour." : "Mira Sol kündigt mit „Glas“ ihr neues Album an.",
    content_html: tour
      ? `<p>Die Berliner Indie-Band <strong>Nordlicht Kollektiv</strong> bringt ihr drittes Album „Weite“ im März 2027 auf die Bühne. Die <strong>Nordlicht Kollektiv Tour 2027</strong> führt durch vier Städte.</p>
<h2>Nordlicht Kollektiv Tour 2027: Alle Termine</h2>
<ul><li>12.03.2027 – Hamburg – Uebel &amp; Gefährlich</li><li>14.03.2027 – Köln – Gloria</li><li>15.03.2027 – München – Technikum</li><li>18.03.2027 – Wien – Flex</li></ul>
<h2>Tickets</h2><p>Tickets ab 32 € gibt es ab Freitag um 10 Uhr <a href="https://tickets.example.com/nordlicht">im Vorverkauf</a>.</p>`
      : `<p><strong>Mira Sol</strong> veröffentlicht am 14. November die Single „Glas“ – der erste Vorbote ihres neuen Albums.</p><h2>Video-Premiere am Releasetag</h2><p>Das Musikvideo zu „Glas“ erscheint am selben Tag auf YouTube.</p>`,
    category: tour ? "Tourdaten" : "Releases",
    tags: tour ? ["Nordlicht Kollektiv", "Indie", "Tour 2027", "Hamburg", "Wien"] : ["Mira Sol", "Single", "Pop"],
    image_credit: tour ? "Jana Weiss" : "",
  }, ["News", "Tourdaten", "Releases", "Festivals"]);
}

export function demoDeps(store: Store): Deps {
  const mails = new Map(MAILS.map((m) => [m.uid, m]));
  let postsToday = 1;
  return {
    mailbox: {
      candidates: async () => [...mails.values()],
      get: async (uid) => mails.get(uid) ?? null,
      mark: async (uid) => void mails.delete(uid),
    },
    wordpress: {
      postsToday: async () => postsToday,
      slugExists: async () => false,
      createPost: async (a) => ({ id: ++postsToday, link: `https://example.com/${a.slug}/` }),
    },
    rewriter: {
      rewrite: async (mail) => {
        await Bun.sleep(1200);
        return mail.uid === 103 ? { ...fakeArticle(mail), relevant: false, reason: "Rechnung, keine Pressemitteilung" } : fakeArticle(mail);
      },
    },
    store,
  };
}

export const DEMO_ENV: Record<string, string> = {
  IMAP_HOST: "demo", IMAP_USER: "demo", IMAP_PASSWORD: "demo",
  WP_URL: "https://example.com", WP_USER: "demo", WP_APP_PASSWORD: "demo",
  WP_CATEGORIES: "News,Tourdaten,Releases,Festivals", SITE_NAME: "Demo-Musikblog",
  DB_PATH: ":memory:", ANTHROPIC_API_KEY: "demo",
};
