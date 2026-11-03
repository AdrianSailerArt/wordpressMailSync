/** Demo-Modus (DEMO=1): Beispiel-Mails und ein simuliertes WordPress, kein Netzwerkzugriff. */

import type { Store } from "./db.ts";
import type { PressMail } from "./mail.ts";
import type { Deps } from "./pipeline.ts";
import { cleanArticle, type Article } from "./rewrite.ts";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const MAILS: PressMail[] = [
  {
    uid: 101, messageId: "<demo-101@example>", subject: "PRESSEINFO: Nordlicht Kollektiv – „Weite“ Tour 2027", sender: "Lena Krause <presse@sternklang-promo.de>", date: hoursAgo(2), images: [],
    body: "Das Berliner Indie-Quintett Nordlicht Kollektiv geht im Frühjahr 2027 mit seinem dritten Album „Weite“ auf Tour.\n\n12.03.2027 Hamburg – Uebel & Gefährlich\n14.03.2027 Köln – Gloria\n15.03.2027 München – Technikum\n18.03.2027 Wien – Flex\n\nTickets ab 32 € gibt es ab Freitag, 10 Uhr, unter https://tickets.example.com/nordlicht.\n\nFoto: Jana Weiss",
  },
  {
    uid: 102, messageId: "<demo-102@example>", subject: "Neue Single: Mira Sol – „Glas“ (VÖ 14.11.)", sender: "Label Kontor <promo@labelkontor.example>", date: hoursAgo(20), images: [],
    body: "Mira Sol veröffentlicht am 14. November ihre neue Single „Glas“, die erste Auskopplung aus dem kommenden Album. Das Video feiert am selben Tag Premiere auf YouTube.",
  },
  {
    uid: 103, messageId: "<demo-103@example>", subject: "Ihre Rechnung Nr. 2026-1188", sender: "Hosting GmbH <billing@hosting.example>", date: hoursAgo(30), images: [],
    body: "Sehr geehrter Kunde, anbei Ihre Rechnung für November.",
  },
];

function fakeArticle(mail: PressMail): Article {
  const tour = mail.uid === 101;
  return cleanArticle({
    relevant: true,
    reason: "Demo",
    featured_image: "",
    inline_images: [],
    seo_title: "",
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
    category: "News",
    tags: tour ? ["Nordlicht Kollektiv", "Indie", "Tour 2027", "Hamburg", "Wien"] : ["Mira Sol", "Single", "Pop"],
    image_credit: tour ? "Jana Weiss" : "",
  }, ["News", "Events"]);
}

export function demoDeps(store: Store): Deps {
  const mails = new Map(MAILS.map((m) => [m.uid, m]));
  let postsToday = 1;
  return {
    mailbox: {
      candidates: async (done = new Set()) => [...mails.values()].filter((m) => !done.has(m.messageId)),
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
    images: {
      collect: async (mail) => ({
        images: (DEMO_IMAGES[mail.uid] ?? []).map(({ data, ...info }) => info),
        downloadLinks: mail.uid === 101 ? [{ url: "https://example.com/pressefotos.zip", label: "Pressefotos (hi-res)" }] : [],
      }),
      read: async (mail, id) => {
        const uid = MAILS.find((m) => m.messageId === mail.messageId)?.uid ?? 0;
        return DEMO_IMAGES[uid]?.find((i) => i.id === id) ?? null;
      },
    },
    store,
  };
}

/** Platzhalter-„Fotos“ als SVG – nur für den Demo-Modus. */
function placeholder(id: string, w: number, h: number, from: string, to: string, label: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(h / 9)}" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
  return { id, origin: "verlinkt" as const, filename: `${id}.svg`, contentType: "image/svg+xml", width: w, height: h, bytes: svg.length, data: Buffer.from(svg) };
}

const DEMO_IMAGES: Record<number, ReturnType<typeof placeholder>[]> = {
  101: [
    placeholder("a1b2c3d4e5f6", 2400, 1600, "#1e3a8a", "#7c3aed", "Bandfoto"),
    placeholder("b2c3d4e5f6a1", 1500, 1500, "#0f172a", "#0891b2", "Albumcover"),
    placeholder("c3d4e5f6a1b2", 1200, 1600, "#7f1d1d", "#ea580c", "Live"),
  ],
  102: [placeholder("d4e5f6a1b2c3", 1600, 1600, "#831843", "#f59e0b", "Single-Cover")],
};

export const DEMO_ENV: Record<string, string> = {
  IMAP_HOST: "demo", IMAP_USER: "demo", IMAP_PASSWORD: "demo",
  WP_URL: "https://example.com", WP_USER: "demo", WP_APP_PASSWORD: "demo",
  WP_CATEGORIES: "News,Events", SITE_NAME: "Demo-Musikblog",
  DB_PATH: ":memory:",
};
