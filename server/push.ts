/** Web Push: Chrome-Benachrichtigungen, auch wenn das Dashboard-Tab geschlossen ist. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import type { Store } from "./db.ts";

export class Push {
  readonly publicKey: string;

  constructor(private store: Store, dataDir: string) {
    // Schlüsselpaar einmalig erzeugen – ändert es sich, werden alle Abos ungültig
    const file = join(dataDir, "vapid.json");
    let keys: { publicKey: string; privateKey: string };
    if (existsSync(file)) {
      keys = JSON.parse(readFileSync(file, "utf8"));
    } else {
      keys = webpush.generateVAPIDKeys();
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
    webpush.setVapidDetails("https://github.com/AdrianSailerArt/wordpressMailSync", keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
  }

  subscribe(sub: PushSubscription): void {
    if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("Ungültiges Push-Abo");
    this.store.addSubscription(sub);
  }

  unsubscribe(endpoint: string): void {
    this.store.removeSubscription(endpoint);
  }

  /** An alle registrierten Browser senden; abgelaufene Abos werden entfernt. */
  async notify(n: { title: string; body: string; url: string; tag: string }): Promise<void> {
    const payload = JSON.stringify(n);
    await Promise.all(this.store.subscriptions<PushSubscription>().map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 6 * 3600 });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.store.removeSubscription(sub.endpoint);
        else throw err;
      }
    }));
  }

  count(): number {
    return this.store.subscriptions().length;
  }
}
