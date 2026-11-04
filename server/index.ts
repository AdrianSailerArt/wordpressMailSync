/** HTTP-Server: REST-API fürs Vue-Dashboard, Auslieferung des Builds und Zeitpläne. */

import { Cron } from "croner";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { totalmem } from "node:os";
import { createApp, modelSetting } from "./app.ts";
import { LLM_PROVIDERS, loadKalenderConfig, type LlmProvider } from "./config.ts";
import { Kalender, type Auswahl, type KalenderResult } from "./kalender/sync.ts";
import { mailCsp } from "./mail-view.ts";
import { ArticleSchema, defaultModel } from "./rewrite.ts";

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

/** Konzertkalender (täglich, wenn KALENDER_AUTO=true) – Veranstalter-Seiten, Vaddi, Ticketmaster → WordPress-Plugin. */
// dieselbe Sprachmodell-Einstellung wie das Postfach, damit die Wahl im Dashboard für beide gilt
const kalenderCfg = { ...loadKalenderConfig(), llm: cfg.llm };
const kalender = new Kalender(kalenderCfg, () => rewriter.model, store);
const lastKalender = (): KalenderResult | null => JSON.parse(store.getSetting("kalender_last") ?? "null");
/** `selected`: Anzahl einzeln übertragener Termine, `sources`: einzeln übertragene Quellen */
const saveKalender = (result: KalenderResult, selected?: number, sources?: string[]) => {
  store.setSetting("kalender_last", JSON.stringify(result));
  // Fehler ist nur, was dieses Mal schiefging: Übertragen gescheitert oder gar keine Quelle erreichbar.
  // Einzelne Quellen ohne Abruf (z. B. Ticketmaster ohne Schlüssel) stehen nur als Hinweis dabei.
  const sendFailed = result.sources.filter((s) => s.sendError);
  const fetchFailed = result.sources.filter((s) => s.error);
  const failed = sendFailed.length > 0 || (result.sources.length > 0 && fetchFailed.length === result.sources.length);
  const names = sources?.map((id) => result.sources.find((s) => s.id === id)?.name ?? id).join(", ");
  const what = selected
    ? `${selected} ausgewählte Termine übertragen`
    : names ? `${names} übertragen` : `${result.events.length} Termine${result.dryRun ? " (Probelauf)" : " übertragen"}`;
  const notes = [
    sendFailed.length && `Übertragen fehlgeschlagen bei ${sendFailed.map((s) => s.name).join(", ")}`,
    fetchFailed.length && `nicht abrufbar: ${fetchFailed.map((s) => s.name).join(", ")}`,
  ].filter(Boolean);
  store.log(failed ? "error" : "run", "Konzertkalender", `${what}${notes.length ? ` – ${notes.join(" · ")}` : ""}`);
  return result;
};
const kalenderLog = (line: string) => console.log(`[Kalender] ${line}`);
const runKalender = async (dryRun = false, only?: string[]) => {
  const result = await kalender.run({ dryRun, only, log: kalenderLog });
  // Einzeltest oder Abbruch: nur die fertigen Quellen ersetzen, die übrigen behalten ihr voriges Ergebnis
  if (result.cancelled) store.log("run", "Konzertkalender", `Abgebrochen nach ${result.sources.length} Quellen – nichts übertragen`);
  return saveKalender(only?.length || result.cancelled ? kalender.combine(lastKalender(), result) : result);
};
/** Abruf dauert mit dem lokalen Modell viele Minuten – im Hintergrund, das Dashboard fragt den Fortschritt ab. */
const inBackground = (task: () => Promise<unknown>) => {
  if (kalender.busy) throw new Error("Der Kalender wird gerade schon abgerufen");
  task().catch((err) => {
    console.error(`[Kalender] Fehler: ${message(err)}`);
    store.log("error", "Konzertkalender", message(err));
  });
};
const kalenderJob = kalenderCfg.auto
  ? new Cron(kalenderCfg.schedule, { timezone: kalenderCfg.timezone, protect: true }, async () => {
      try {
        await runKalender();
      } catch (err) {
        console.error(`[Kalender] Fehler: ${message(err)}`);
      }
    })
  : null;

const app = new Hono();

if (cfg.server.password) {
  app.use("*", basicAuth({ username: "admin", password: cfg.server.password }));
}

app.onError((err, c) => {
  console.error(`[${c.req.method} ${c.req.path}] ${message(err)}`);
  return c.json({ error: message(err) }, 500);
});

const uid = (c: { req: { param(k: "uid"): string } }) => Number(c.req.param("uid"));

const PROVIDER_LABEL: Record<LlmProvider, string> = { ollama: "Ollama", mlx: "MLX", claude: "Claude" };

/** Gewähltes Modell eines Anbieters (auch wenn er gerade nicht aktiv ist) */
const modelFor = (provider: LlmProvider) =>
  provider === "claude" ? cfg.llm.claudeModel : store.getSetting(modelSetting(provider)) || defaultModel({ ...cfg.llm, provider });

interface LlmModel {
  name: string; sizeGB: number; params: string; quantization: string; family: string; loaded: boolean; tooBig: boolean;
}

/** Installierte Modelle eines Anbieters; zu große (mehr als ~70 % des Arbeitsspeichers) werden markiert */
async function listModels(provider: LlmProvider): Promise<{ models: LlmModel[]; error?: string }> {
  const ramGB = totalmem() / 1e9;
  if (provider === "claude") {
    return cfg.llm.claudeKey
      ? { models: [{ name: cfg.llm.claudeModel, sizeGB: 0, params: "", quantization: "", family: "Claude-API", loaded: false, tooBig: false }] }
      : { models: [], error: "Für Claude fehlt ANTHROPIC_API_KEY in der .env" };
  }
  if (provider === "mlx") {
    try {
      // mlx_lm.server nennt alle heruntergeladenen Hugging-Face-Modelle
      const res = await fetch(`${cfg.llm.mlxUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id).sort();
      return {
        models: ids.map((name) => ({
          name, sizeGB: 0, params: name.match(/(\d+(?:\.\d+)?b)\b/i)?.[1]?.toUpperCase() ?? "",
          quantization: name.match(/(\d+)-?bit/i)?.[0] ?? "", family: "", loaded: false, tooBig: false,
        })),
      };
    } catch {
      return { models: [], error: `MLX nicht erreichbar unter ${cfg.llm.mlxUrl} – läuft mlx_lm.server?` };
    }
  }
  try {
    type Tag = { name: string; size: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } };
    const [tags, ps] = await Promise.all([
      fetch(`${cfg.llm.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ models: Tag[] }>),
      fetch(`${cfg.llm.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ models: { name: string }[] }>),
    ]);
    const loaded = new Set(ps.models.map((m) => m.name));
    return {
      models: tags.models.map((m) => ({
        name: m.name.replace(/:latest$/, ""),
        sizeGB: Math.round(m.size / 1e8) / 10,
        params: m.details?.parameter_size ?? "",
        quantization: m.details?.quantization_level ?? "",
        family: m.details?.family ?? "",
        loaded: loaded.has(m.name),
        tooBig: m.size / 1e9 > ramGB * 0.7,
      })),
    };
  } catch {
    return { models: [], error: `Ollama nicht erreichbar unter ${cfg.llm.ollamaUrl} – läuft die Ollama-App?` };
  }
}

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
        model: cfg.llm.provider === "claude" ? `Claude (${rewriter.model})` : `lokal: ${rewriter.model} (${cfg.llm.provider === "mlx" ? "MLX" : "Ollama"})`,
        provider: cfg.llm.provider,
        activeModel: rewriter.model,
        mailboxes: pipeline.mailboxStatus(),
        seoPlugin: cfg.wp.seoPlugin,
        categories: cfg.wp.categories,
        timezone: cfg.limits.timezone,
        perRun: cfg.limits.perRun,
        autoPublish: cfg.limits.autoPublish,
        suggestSchedule: cfg.limits.suggestSchedule,
      },
    });
  })
  .get("/wp/categories", async (c) => c.json(await pipeline.categories()))
  .get("/mails", async (c) => {
    const mails = await pipeline.listMails();
    return c.json({ mails, mailboxes: pipeline.mailboxStatus() });
  })
  .get("/mails/:uid", async (c) => c.json(await pipeline.original(uid(c))))
  .get("/mails/:uid/html", async (c) => {
    const images = c.req.query("images") === "1";
    const html = await pipeline.originalHtml(uid(c), images);
    if (html === null) return c.notFound();
    return c.html(html, 200, {
      "Content-Security-Policy": mailCsp(images),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
  })
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
  .post("/run", async (c) => c.json(await pipeline.run(c.req.query("dryRun") === "1", { manual: true })))
  .post("/suggest", async (c) => c.json(await pipeline.suggest()))
  .get("/log", (c) => c.json(store.recentLog()))
  .get("/mails/:uid/trace", (c) => c.json(store.getTrace(uid(c))))
  // Anbieter (Ollama, MLX, Claude) und ihre Modelle; ?provider= zeigt einen anderen als den aktiven
  .get("/llm/models", async (c) => {
    const active = cfg.llm.provider;
    const requested = c.req.query("provider") as LlmProvider | undefined;
    const provider = requested && LLM_PROVIDERS.includes(requested) ? requested : active;
    return c.json({
      provider,
      active,
      activeModel: rewriter.model,
      current: modelFor(provider),
      ramGB: Math.round(totalmem() / 1e9),
      providers: LLM_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id], available: id !== "claude" || cfg.llm.claudeKey })),
      ...(await listModels(provider)),
    });
  })
  // Anbieter und Modell wechseln – gilt ab dem nächsten Entwurf bzw. Kalender-Abruf
  .put("/llm/model", async (c) => {
    const body = (await c.req.json()) as { model: string; provider?: LlmProvider };
    const provider = body.provider ?? cfg.llm.provider;
    if (!LLM_PROVIDERS.includes(provider)) return c.json({ error: `Unbekannter Anbieter „${provider}“` }, 400);
    if (provider === "claude" && !cfg.llm.claudeKey) return c.json({ error: "Für Claude fehlt ANTHROPIC_API_KEY in der .env" }, 400);
    const { models, error } = await listModels(provider);
    if (error) return c.json({ error }, 400);
    if (!models.some((m) => m.name === body.model)) return c.json({ error: `Modell „${body.model}“ ist nicht installiert` }, 400);
    if (provider !== "claude") store.setSetting(modelSetting(provider), body.model);
    store.setSetting("llm_provider", provider);
    cfg.llm.provider = provider;
    return c.json({ provider, current: rewriter.model });
  })
  // Abbrechen-Knopf: laufenden Entwurf stoppen (die Mail bleibt unbearbeitet)
  .post("/llm/cancel", (c) => c.json({ cancelled: pipeline.cancel() }))
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
  .get("/kalender", (c) => c.json({
    busy: kalender.busy,
    progress: kalender.progress,
    nextRun: kalenderJob?.nextRun()?.toISOString() ?? null,
    config: { schedule: kalenderCfg.schedule, auto: kalenderCfg.auto, postStatus: kalenderCfg.postStatus, ticketmaster: !!kalenderCfg.ticketmasterKey, wpUrl: kalenderCfg.wp.url },
    sources: kalender.sources(),
    last: lastKalender(),
  }))
  .post("/kalender/run", (c) => {
    const only = c.req.query("only")?.split(",").filter(Boolean);
    inBackground(() => runKalender(c.req.query("dryRun") === "1", only));
    return c.json({ started: true }, 202);
  })
  .post("/kalender/cancel", (c) => c.json({ cancelled: kalender.cancel() }))
  // Vergleich des letzten Abrufs mit dem Bestand in WordPress (Dubletten, Änderungen, was wegfiele)
  .get("/kalender/abgleich", async (c) => {
    const last = lastKalender();
    if (!last) return c.json({ error: "Noch kein Abruf vorhanden" }, 400);
    return c.json(await kalender.abgleich(last));
  })
  // letzten Abruf übertragen, ohne die Seiten noch einmal zu lesen – alle oder nur { uids: [...] }
  .post("/kalender/transfer", async (c) => {
    const last = lastKalender();
    if (!last) return c.json({ error: "Noch kein Abruf vorhanden" }, 400);
    const sel = (await c.req.json().catch(() => ({}))) as Auswahl;
    inBackground(async () => saveKalender(await kalender.transfer(last, kalenderLog, sel), sel.uids?.length, sel.sources));
    return c.json({ started: true }, 202);
  })
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
    await push.notify({ title: "Bühnenpost", body: "Benachrichtigungen funktionieren.", url: "/", tag: "test" });
    return c.json({ ok: true });
  });

app.route("/api", api);
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

console.log(`Dashboard: http://${cfg.server.host}:${cfg.server.port}`);
console.log(`Vorschläge: „${cfg.limits.suggestSchedule}“ – nächster ${at(suggestJob)}`);
console.log(kalenderJob ? `Konzertkalender: „${kalenderCfg.schedule}“ – nächster ${at(kalenderJob)}` : "Konzertkalender: nur von Hand (KALENDER_AUTO=false)");
console.log(publishJob ? `Veröffentlichen: „${cfg.limits.schedule}“ – nächstes ${at(publishJob)}` : "Automatisches Veröffentlichen ist aus (AUTO_PUBLISH=false)");

export default {
  hostname: cfg.server.host,
  port: cfg.server.port,
  fetch: app.fetch,
  idleTimeout: 255, // Sprachmodell und Bild-Downloads können eine Weile dauern
};
