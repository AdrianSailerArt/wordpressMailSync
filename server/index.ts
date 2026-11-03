/** HTTP-Server: REST-API fürs Vue-Dashboard, Auslieferung des Builds und Zeitpläne. */

import { Cron } from "croner";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { totalmem } from "node:os";
import { createApp } from "./app.ts";
import { ArticleSchema } from "./rewrite.ts";

const { cfg, store, push, events, rewriter, pipeline } = createApp();

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const at = (cron: Cron | null) => cron?.nextRun()?.toLocaleString("de-DE", { timeZone: cfg.limits.timezone }) ?? "–";

/** Veröffentlichen (3× täglich) – lässt sich mit AUTO_PUBLISH=false abschalten. */
const publishJob = cfg.limits.autoPublish
  ? new Cron(cfg.limits.schedule, { timezone: cfg.limits.timezone, protect: true }, async () => {
      try {
        console.log(`[Veröffentlichen] ${(await pipeline.run()).message}`);
      } catch (err) {
        console.error(`[Veröffentlichen] Fehler: ${message(err)}`);
      }
    })
  : null;

/** Vorschläge (10× täglich) – erzeugt Entwürfe und benachrichtigt per Push. */
const suggestJob = new Cron(cfg.limits.suggestSchedule, { timezone: cfg.limits.timezone, protect: true }, async () => {
  try {
    console.log(`[Vorschlag] ${(await pipeline.suggest()).message}`);
  } catch (err) {
    console.error(`[Vorschlag] Fehler: ${message(err)}`);
  }
});

const app = new Hono();

if (cfg.server.password) {
  app.use("*", basicAuth({ username: "admin", password: cfg.server.password }));
}

app.onError((err, c) => {
  console.error(`[${c.req.method} ${c.req.path}] ${message(err)}`);
  return c.json({ error: message(err) }, 500);
});

const uid = (c: { req: { param(k: "uid"): string } }) => Number(c.req.param("uid"));

const api = new Hono()
  .get("/status", async (c) => {
    const { today, limit } = await pipeline.remainingToday();
    return c.json({
      today,
      limit,
      busy: pipeline.busy,
      schedule: cfg.limits.schedule,
      nextRun: publishJob?.nextRun()?.toISOString() ?? null,
      nextSuggestion: suggestJob.nextRun()?.toISOString() ?? null,
      pushSubscribers: push.count(),
      config: {
        site: cfg.llm.siteName,
        wpUrl: cfg.wp.url,
        wpStatus: cfg.wp.status,
        model: cfg.llm.provider === "claude" ? `Claude (${rewriter.model})` : `lokal: ${rewriter.model} (Ollama)`,
        provider: cfg.llm.provider,
        activeModel: rewriter.model,
        folder: cfg.imap.folder,
        seoPlugin: cfg.wp.seoPlugin,
        categories: cfg.wp.categories,
        timezone: cfg.limits.timezone,
        perRun: cfg.limits.perRun,
        autoPublish: cfg.limits.autoPublish,
        suggestSchedule: cfg.limits.suggestSchedule,
      },
    });
  })
  .get("/mails", async (c) => c.json(await pipeline.listMails()))
  .get("/mails/:uid", async (c) => c.json(await pipeline.original(uid(c))))
  .get("/mails/:uid/images", async (c) => c.json(await pipeline.images(uid(c))))
  .get("/mails/:uid/images/:id", async (c) => {
    const img = await pipeline.image(uid(c), c.req.param("id"));
    if (!img) return c.notFound();
    return c.body(new Uint8Array(img.data), 200, { "Content-Type": img.contentType, "Cache-Control": "private, max-age=86400" });
  })
  .post("/mails/:uid/preview", async (c) => c.json(await pipeline.preview(uid(c), c.req.query("refresh") === "1")))
  .put("/mails/:uid/draft", async (c) => c.json(pipeline.saveDraft(uid(c), ArticleSchema.parse(await c.req.json()))))
  .post("/mails/:uid/publish", async (c) => c.json(await pipeline.publish(uid(c))))
  .post("/mails/:uid/skip", async (c) => {
    await pipeline.skip(uid(c));
    return c.json({ ok: true });
  })
  .post("/run", async (c) => c.json(await pipeline.run(c.req.query("dryRun") === "1")))
  .post("/suggest", async (c) => c.json(await pipeline.suggest()))
  .get("/log", (c) => c.json(store.recentLog()))
  .get("/mails/:uid/trace", (c) => c.json(store.getTrace(uid(c))))
  // Installierte Ollama-Modelle; zu große Modelle (mehr als ~70 % des Arbeitsspeichers) werden markiert
  .get("/llm/models", async (c) => {
    const ramGB = totalmem() / 1e9;
    const base = { provider: cfg.llm.provider, current: rewriter.model, ramGB: Math.round(ramGB) };
    if (cfg.llm.provider === "claude") return c.json({ ...base, models: [] });
    try {
      type Tag = { name: string; size: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } };
      const [tags, ps] = await Promise.all([
        fetch(`${cfg.llm.ollamaUrl}/api/tags`).then((r) => r.json() as Promise<{ models: Tag[] }>),
        fetch(`${cfg.llm.ollamaUrl}/api/ps`).then((r) => r.json() as Promise<{ models: { name: string }[] }>),
      ]);
      const loaded = new Set(ps.models.map((m) => m.name));
      return c.json({
        ...base,
        models: tags.models.map((m) => ({
          name: m.name.replace(/:latest$/, ""),
          sizeGB: Math.round(m.size / 1e8) / 10,
          params: m.details?.parameter_size ?? "",
          quantization: m.details?.quantization_level ?? "",
          family: m.details?.family ?? "",
          loaded: loaded.has(m.name),
          tooBig: m.size / 1e9 > ramGB * 0.7,
        })),
      });
    } catch {
      return c.json({ ...base, models: [], error: `Ollama nicht erreichbar unter ${cfg.llm.ollamaUrl}` });
    }
  })
  .put("/llm/model", async (c) => {
    const { model } = (await c.req.json()) as { model: string };
    const tags = (await (await fetch(`${cfg.llm.ollamaUrl}/api/tags`)).json()) as { models: { name: string }[] };
    if (!tags.models.some((m) => m.name === model || m.name === `${model}:latest`)) return c.json({ error: `Modell „${model}“ ist nicht installiert` }, 400);
    store.setSetting("ollama_model", model);
    return c.json({ current: rewriter.model });
  })
  // Live-Datenstrom: was das Modell gerade schreibt (Server-Sent Events)
  .get("/llm/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const send = (data: unknown) => {
        queue.push(JSON.stringify(data));
        wake?.();
      };
      send({ type: "snapshot", active: events.active() });
      const unsubscribe = events.subscribe(send);
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        if (!queue.length) await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(20_000)]);
        wake = null;
        if (!queue.length) await stream.writeSSE({ event: "ping", data: "" }); // hält die Verbindung offen
        while (queue.length) await stream.writeSSE({ data: queue.shift()! });
      }
      unsubscribe();
    }))
  .get("/push/key", (c) => c.json({ publicKey: push.publicKey }))
  .post("/push/subscribe", async (c) => {
    push.subscribe(await c.req.json());
    return c.json({ ok: true });
  })
  .post("/push/unsubscribe", async (c) => {
    push.unsubscribe(((await c.req.json()) as { endpoint: string }).endpoint);
    return c.json({ ok: true });
  })
  .post("/push/test", async (c) => {
    await push.notify({ title: "Mail Sync", body: "Benachrichtigungen funktionieren.", url: "/", tag: "test" });
    return c.json({ ok: true });
  });

app.route("/api", api);
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

console.log(`Dashboard: http://${cfg.server.host}:${cfg.server.port}`);
console.log(`Vorschläge: „${cfg.limits.suggestSchedule}“ – nächster ${at(suggestJob)}`);
console.log(publishJob ? `Veröffentlichen: „${cfg.limits.schedule}“ – nächstes ${at(publishJob)}` : "Automatisches Veröffentlichen ist aus (AUTO_PUBLISH=false)");

export default {
  hostname: cfg.server.host,
  port: cfg.server.port,
  fetch: app.fetch,
  idleTimeout: 255, // Sprachmodell und Bild-Downloads können eine Weile dauern
};
