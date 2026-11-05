/** Verdrahtung der Abhängigkeiten – gemeinsam für Server und CLI. */

import { join } from "node:path";
import { LLM_PROVIDERS, loadConfig, type Config, type LlmProvider } from "./config.ts";
import { Store } from "./db.ts";
import { DEMO_ENV, demoDeps } from "./demo.ts";
import { ImageStore } from "./images.ts";
import { LlmEvents } from "./llm-events.ts";
import { loadAccounts } from "./accounts.ts";
import { Mailboxes } from "./mail.ts";
import { Pipeline } from "./pipeline.ts";
import { Push } from "./push.ts";
import { Rewriter } from "./rewrite.ts";
import { WordPress } from "./wordpress.ts";

export const modelSetting = (provider: LlmProvider) => `${provider}_model`;

/** Cloud-Anbieter sind nur wählbar, wenn ihr API-Key in der .env steht */
export const providerReady = (cfg: Config["llm"], provider: LlmProvider) =>
  provider === "claude" ? cfg.claudeKey : provider === "openai" ? !!cfg.openaiKey : true;

/** LLM_PROVIDER ist nur der Standard – die Wahl im Dashboard bleibt gespeichert. */
function applyStoredProvider(cfg: Config["llm"], store: Store) {
  const stored = store.getSetting("llm_provider") as LlmProvider | null;
  if (stored && LLM_PROVIDERS.includes(stored) && providerReady(cfg, stored)) cfg.provider = stored;
}

export function createApp() {
  const demo = process.env.DEMO === "1";
  if (demo) for (const [k, v] of Object.entries(DEMO_ENV)) process.env[k] ??= v;

  const cfg = loadConfig();
  const store = new Store(cfg.server.dbPath);
  applyStoredProvider(cfg.llm, store);
  const push = new Push(store, cfg.server.dataDir);
  const events = new LlmEvents();
  const rewriter = new Rewriter(cfg.llm, cfg.wp.categories, {
    // im Dashboard gewähltes Modell, je Anbieter getrennt gespeichert
    model: () => store.getSetting(modelSetting(cfg.llm.provider)) ?? "",
    events,
    onTrace: (t) => store.saveTrace(t),
  });
  // Postfächer stehen in der Datenbank – die aus der .env werden beim ersten Start übernommen
  const accounts = loadAccounts(store, cfg.imap.accounts);
  const mailboxes = demo ? null : new Mailboxes(accounts, cfg.imap.maxAgeDays);
  const deps = demo
    ? { ...demoDeps(store, events), notifier: push }
    : {
        mailbox: mailboxes!,
        wordpress: new WordPress(cfg.wp, cfg.limits.timezone),
        rewriter,
        images: new ImageStore(join(cfg.server.dataDir, "images")),
        notifier: push,
        store,
      };
  return { cfg, store, push, events, rewriter, pipeline: new Pipeline(cfg, deps), demo, mailboxes, accounts };
}
