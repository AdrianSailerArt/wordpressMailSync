/**
 * Testlauf ohne Server: zeigt, welche Beiträge aus den offenen Mails entstünden.
 * Veröffentlicht wird hier nie – nur über die Freigabe eines Entwurfs im Dashboard.
 */

import { createApp } from "./app.ts";

const { pipeline } = createApp();
const result = await pipeline.run();

for (const article of result.previews) {
  console.log(`\n=== ${article.title} ===\nSlug: ${article.slug}\nKategorie: ${article.category}\nTags: ${article.tags.join(", ")}\nMeta: ${article.meta_description}\n\n${article.content_html}\n`);
}
console.log(result.message);
