/** Bisher gesehene Bilder der WordPress-Mediathek – damit Editor und Vorschau gewählte Bilder zeigen können. */

import { reactive } from "vue";
import type { WpMedia } from "./api";

export const mediaCache = reactive(new Map<number, WpMedia>());

export const rememberMedia = (list: WpMedia[]) => {
  for (const m of list) mediaCache.set(m.id, m);
};

/** „wp:123“ → Bild aus dem Zwischenspeicher */
export const cachedMedia = (id: string): WpMedia | undefined =>
  id.startsWith("wp:") ? mediaCache.get(Number(id.slice(3))) : undefined;
