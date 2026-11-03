/** Verdrahtung der Abhängigkeiten – gemeinsam für Server und CLI. */

import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { DEMO_ENV, demoDeps } from "./demo.ts";
import { ImageStore } from "./images.ts";
import { LlmEvents } from "./llm-events.ts";
import { Mailbox } from "./mail.ts";
import { Pipeline } from "./pipeline.ts";
import { Push } from "./push.ts";
import { Rewriter } from "./rewrite.ts";
import { WordPress } from "./wordpress.ts";

export function createApp() {
  const demo = process.env.DEMO === "1";
  if (demo) for (const [k, v] of Object.entries(DEMO_ENV)) process.env[k] ??= v;

  const cfg = loadConfig();
  const store = new Store(cfg.server.dbPath);
  const push = new Push(store, cfg.server.dataDir);
  const events = new LlmEvents();
  const rewriter = new Rewriter(cfg.llm, cfg.wp.categories, {
    model: () => store.getSetting("ollama_model") ?? "",
    events,
    onTrace: (t) => store.saveTrace(t),
  });
  const deps = demo
    ? { ...demoDeps(store, events), notifier: push }
    : {
        mailbox: new Mailbox(cfg.imap),
        wordpress: new WordPress(cfg.wp, cfg.limits.timezone),
        rewriter,
        images: new ImageStore(join(cfg.server.dataDir, "images")),
        notifier: push,
        store,
      };
  return { cfg, store, push, events, rewriter, pipeline: new Pipeline(cfg, deps), demo };
}
