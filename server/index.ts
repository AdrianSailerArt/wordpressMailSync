/** HTTP-Server: REST-API fürs Vue-Dashboard, Auslieferung des Builds und Zeitplan. */

import { Cron } from "croner";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { createApp } from "./app.ts";
import { ArticleSchema } from "./rewrite.ts";

const { cfg, store, pipeline } = createApp();

const job = new Cron(cfg.limits.schedule, { timezone: cfg.limits.timezone, protect: true }, async () => {
  try {
    const result = await pipeline.run();
    console.log(`[Zeitplan] ${result.message}`);
  } catch (err) {
    console.error(`[Zeitplan] Fehler: ${message(err)}`);
  }
});

const app = new Hono();

if (cfg.server.password) {
  app.use("*", basicAuth({ username: "admin", password: cfg.server.password }));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

app.onError((err, c) => {
  console.error(`[${c.req.method} ${c.req.path}] ${message(err)}`);
  return c.json({ error: message(err) }, 500);
});

const api = new Hono()
  .get("/status", async (c) => {
    const { today, limit } = await pipeline.remainingToday();
    return c.json({
      today,
      limit,
      busy: pipeline.busy,
      schedule: cfg.limits.schedule,
      nextRun: job.nextRun()?.toISOString() ?? null,
      config: {
        site: cfg.llm.siteName,
        wpUrl: cfg.wp.url,
        wpStatus: cfg.wp.status,
        model: cfg.llm.provider === "claude" ? `Claude (${cfg.llm.claudeModel})` : `lokal: ${cfg.llm.ollamaModel} (Ollama)`,
        folder: cfg.imap.folder,
        seoPlugin: cfg.wp.seoPlugin,
        categories: cfg.wp.categories,
        timezone: cfg.limits.timezone,
        perRun: cfg.limits.perRun,
      },
    });
  })
  .get("/mails", async (c) => c.json(await pipeline.listMails()))
  .get("/mails/:uid", async (c) => c.json(await pipeline.original(Number(c.req.param("uid")))))
  .post("/mails/:uid/preview", async (c) =>
    c.json(await pipeline.preview(Number(c.req.param("uid")), c.req.query("refresh") === "1")))
  .put("/mails/:uid/draft", async (c) =>
    c.json(pipeline.saveDraft(Number(c.req.param("uid")), ArticleSchema.parse(await c.req.json()))))
  .post("/mails/:uid/publish", async (c) => c.json(await pipeline.publish(Number(c.req.param("uid")))))
  .post("/mails/:uid/skip", async (c) => {
    await pipeline.skip(Number(c.req.param("uid")));
    return c.json({ ok: true });
  })
  .post("/run", async (c) => c.json(await pipeline.run(c.req.query("dryRun") === "1")))
  .get("/log", (c) => c.json(store.recentLog()));

app.route("/api", api);
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

console.log(`Dashboard: http://${cfg.server.host}:${cfg.server.port}  ·  Zeitplan „${cfg.limits.schedule}“ (${cfg.limits.timezone}), nächster Lauf ${job.nextRun()?.toLocaleString("de-DE", { timeZone: cfg.limits.timezone })}`);

export default {
  hostname: cfg.server.host,
  port: cfg.server.port,
  fetch: app.fetch,
  idleTimeout: 255, // Claude-Aufrufe können eine Weile dauern
};
