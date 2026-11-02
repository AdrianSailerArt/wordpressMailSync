/** Einmaliger Lauf ohne Server, z. B. für Cronjobs oder GitHub Actions. `--dry-run` veröffentlicht nichts. */

import { createApp } from "./app.ts";

const dryRun = process.argv.includes("--dry-run");
const { pipeline } = createApp();
const result = await pipeline.run(dryRun);

for (const article of result.previews) {
  console.log(`\n=== ${article.title} ===\nSlug: ${article.slug}\nKategorie: ${article.category}\nTags: ${article.tags.join(", ")}\nMeta: ${article.meta_description}\n\n${article.content_html}\n`);
}
for (const post of result.published) console.log(`Veröffentlicht: ${post.title} (${post.link})`);
console.log(result.message);
