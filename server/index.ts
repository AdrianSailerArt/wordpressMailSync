/** HTTP-Server: REST-API fürs Vue-Dashboard, Auslieferung des Builds und Zeitpläne. */

import { Cron } from "croner";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { totalmem } from "node:os";
import { createApp, modelSetting, providerReady } from "./app.ts";
import { LLM_PROVIDERS, loadKalenderConfig, normalizeWpUrl, type LlmProvider } from "./config.ts";
import { Kalender, type Auswahl, type KalenderResult } from "./kalender/sync.ts";
import { addLocation, editQuellen, removeLocation, removeOrt, setOrt, updateLocation, type LocationInput } from "./kalender/locations.ts";
import { erkennen } from "./kalender/erkennen.ts";
import { loadQuellen } from "./kalender/events.ts";
import { mailCsp } from "./mail-view.ts";
import { applySetup, loadSetup, mergeSetup, publicSetup, saveSetup, testWordPress, type SetupInput } from "./setup.ts";
import {
  addAccount, guessServer, removeAccount, saveAccounts, testConnection, toPublic, updateAccount,
  type AccountInput, type MailAccount,
} from "./accounts.ts";
import { ArticleSchema, defaultModel } from "./rewrite.ts";

const wiring = createApp();
const { cfg, store, push, events, rewriter, pipeline, mailboxes } = wiring;

/** Postfächer – im Dashboard gepflegt, gespeichert in der Datenbank */
let accounts = wiring.accounts;
function changeAccounts(next: MailAccount[]) {
  saveAccounts(store, next);
  accounts = next;
  mailboxes?.setAccounts(next);
  return publicAccounts();
}
const publicAccounts = () => {
  const errors = new Map(pipeline.mailboxStatus().map((m) => [m.nr, m.error]));
  return accounts.map((a) => ({ ...toPublic(a), error: errors.get(a.nr) }));
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const at = (cron: Cron | null) => cron?.nextRun()?.toLocaleString("de-DE", { timeZone: cfg.limits.timezone }) ?? "–";


/** Konzertkalender (täglich, wenn KALENDER_AUTO=true) – Veranstalter-Seiten, Vaddi, Ticketmaster → WordPress-Plugin. */
// dieselbe Sprachmodell-Einstellung wie das Postfach, damit die Wahl im Dashboard für beide gilt
// WordPress-Zugang teilt sich der Kalender mit den Beiträgen – Änderungen der Einrichtung gelten für beide
const kalenderCfg = { ...loadKalenderConfig(), llm: cfg.llm, wp: cfg.wp };
applySetup(cfg, kalenderCfg, loadSetup(store), wiring.defaults);
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
/**
 * Zeitpläne – nach jeder Änderung in den Einstellungen neu aufgesetzt:
 * Vorschläge mit Benachrichtigung (10× täglich) und Konzertkalender (täglich, wenn eingeschaltet).
 * Beiträge veröffentlicht kein Zeitplan – nur die Freigabe im Dashboard.
 */
let suggestJob: Cron | null = null;
let kalenderJob: Cron | null = null;
const job = (pattern: string, timezone: string, label: string, task: () => Promise<unknown>) =>
  new Cron(pattern, { timezone, protect: true }, async () => {
    try {
      await task();
    } catch (err) {
      console.error(`[${label}] Fehler: ${message(err)}`);
    }
  });
function schedule() {
  for (const j of [suggestJob, kalenderJob]) j?.stop();
  const tz = cfg.limits.timezone;
  suggestJob = job(cfg.limits.suggestSchedule, tz, "Vorschlag", async () => console.log(`[Vorschlag] ${(await pipeline.suggest()).message}`));
  kalenderJob = kalenderCfg.auto ? job(kalenderCfg.schedule, tz, "Kalender", () => runKalender()) : null;
}
schedule();

const app = new Hono();

// Dashboard-Passwort (Benutzer „admin“) – jede Anfrage liest den aktuellen Stand, ändern wirkt sofort
app.use("*", (c, next) => (cfg.server.password ? basicAuth({ username: "admin", password: cfg.server.password })(c, next) : next()));

app.onError((err, c) => {
  // Anmeldung (Dashboard-Passwort) & Co.: Hono liefert die passende Antwort samt Passwort-Abfrage im Browser
  if (err instanceof HTTPException) return err.getResponse();
  console.error(`[${c.req.method} ${c.req.path}] ${message(err)}`);
  return c.json({ error: message(err) }, 500);
});

const uid = (c: { req: { param(k: "uid"): string } }) => Number(c.req.param("uid"));

const PROVIDER_LABEL: Record<LlmProvider, string> = { ollama: "Ollama", mlx: "MLX", opencode: "OpenCode", openai: "ChatGPT", claude: "Claude" };

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
  if (provider === "openai") {
    if (!cfg.llm.openaiKey) return { models: [], error: "Für ChatGPT fehlt OPENAI_API_KEY in der .env" };
    try {
      const res = await fetch(`${cfg.llm.openaiUrl}/models`, {
        headers: { Authorization: `Bearer ${cfg.llm.openaiKey}` }, signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) return { models: [], error: "OpenAI: API-Key ungültig (OPENAI_API_KEY prüfen)" };
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id);
      // nur Text-Chatmodelle – keine Audio-, Bild-, Such- oder Embedding-Varianten
      const chat = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|instruct/.test(id));
      return {
        models: chat.sort().map((name) => ({ name, sizeGB: 0, params: "", quantization: "", family: "OpenAI-API", loaded: false, tooBig: false })),
      };
    } catch {
      return { models: [], error: "OpenAI nicht erreichbar – Internetverbindung prüfen" };
    }
  }
  if (provider === "opencode") {
    try {
      // alle Modelle der in OpenCode eingerichteten Anbieter, als „anbieter/modell“
      type OcModel = { id: string; name: string; family?: string; status?: string; cost?: { input?: number; output?: number } };
      const res = await fetch(`${cfg.llm.opencodeUrl}/config/providers`, { signal: AbortSignal.timeout(5000) });
      const { providers } = (await res.json()) as { providers: { id: string; name: string; models: Record<string, OcModel> }[] };
      const price = (m: OcModel) => (m.cost?.output ? `$${m.cost.input ?? 0} / $${m.cost.output} je 1 Mio. Tokens` : "kostenlos");
      return {
        models: providers.flatMap((p) => Object.values(p.models)
          .filter((m) => m.status !== "deprecated")
          .map((m) => ({ name: `${p.id}/${m.id}`, sizeGB: 0, params: m.name, family: p.name, quantization: price(m), loaded: false, tooBig: false }))),
      };
    } catch {
      return { models: [], error: `OpenCode nicht erreichbar unter ${cfg.llm.opencodeUrl} – läuft „opencode serve --port 4096“?` };
    }
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
    return c.json({
      today: await pipeline.postsToday(),
      busy: pipeline.busy,
      nextSuggestion: suggestJob?.nextRun()?.toISOString() ?? null,
      pushSubscribers: push.count(),
      config: {
        site: cfg.llm.siteName,
        wpUrl: cfg.wp.url,
        wpStatus: cfg.wp.status,
        model: cfg.llm.provider !== "claude" && cfg.llm.provider !== "openai"
          ? `lokal: ${rewriter.model} (${PROVIDER_LABEL[cfg.llm.provider]})`
          : `${PROVIDER_LABEL[cfg.llm.provider]}: ${rewriter.model}`,
        provider: cfg.llm.provider,
        activeModel: rewriter.model,
        mailboxes: pipeline.mailboxStatus(),
        seoPlugin: cfg.wp.seoPlugin,
        categories: cfg.wp.categories,
        timezone: cfg.limits.timezone,
        perRun: cfg.limits.perRun,
        suggestSchedule: cfg.limits.suggestSchedule,
      },
    });
  })
  .get("/wp/categories", async (c) => c.json(await pipeline.categories()))
  // Stil-Regelwerk: eigene Fassung bearbeiten, die Datei bleibt Vorlage
  .get("/regelwerk", (c) => c.json(wiring.regelwerk.state()))
  .put("/regelwerk", async (c) => c.json(wiring.regelwerk.save(((await c.req.json()) as { text: string }).text ?? "")))
  .delete("/regelwerk", (c) => c.json(wiring.regelwerk.reset()))
  // Einrichtung: Website, WordPress, API-Keys – Geheimnisse verlassen den Server nie
  .get("/setup", (c) => c.json(publicSetup(cfg, kalenderCfg, loadSetup(store), accounts.length)))
  .put("/setup", async (c) => {
    const data = mergeSetup(loadSetup(store), (await c.req.json()) as SetupInput);
    saveSetup(store, data);
    applySetup(cfg, kalenderCfg, data, wiring.defaults);
    schedule();
    // ohne Key ist ein Cloud-Anbieter nicht mehr wählbar – dann zurück zum Standard
    if (!providerReady(cfg.llm, cfg.llm.provider)) cfg.llm.provider = "ollama";
    return c.json(publicSetup(cfg, kalenderCfg, data, accounts.length));
  })
  // WordPress-Zugang prüfen, ohne zu speichern – ohne Passwort: das gespeicherte
  .post("/setup/wordpress/test", async (c) => {
    const body = (await c.req.json()) as { url: string; user: string; appPassword?: string };
    // gespeichertes Passwort nur für denselben Zugang – nie an eine andere (vertippte) Adresse schicken
    const same = normalizeWpUrl(body.url ?? "") === cfg.wp.url && body.user === cfg.wp.user;
    const appPassword = body.appPassword || (same ? cfg.wp.appPassword : "");
    if (!appPassword) return c.json({ ok: false, error: "Für eine andere Adresse oder einen anderen Benutzer das Anwendungspasswort neu eingeben", categories: [] });
    return c.json(await testWordPress({ ...body, appPassword }));
  })
  // Postfächer anlegen, ändern, löschen – Passwörter verlassen den Server nie
  .get("/mail/accounts", (c) => c.json(publicAccounts()))
  .post("/mail/accounts", async (c) => c.json(changeAccounts(addAccount(store, accounts, (await c.req.json()) as AccountInput)), 201))
  .put("/mail/accounts/:nr", async (c) =>
    c.json(changeAccounts(updateAccount(accounts, Number(c.req.param("nr")), (await c.req.json()) as AccountInput))))
  .delete("/mail/accounts/:nr", (c) => c.json(changeAccounts(removeAccount(store, accounts, Number(c.req.param("nr"))))))
  // IMAP-Server zur Mail-Adresse vorschlagen
  .post("/mail/accounts/erkennen", async (c) => c.json(await guessServer(((await c.req.json()) as { email: string }).email)))
  // Verbindung prüfen, ohne zu speichern – leeres Passwort: das gespeicherte des Postfachs `nr`
  .post("/mail/accounts/test", async (c) => {
    const body = (await c.req.json()) as AccountInput & { nr?: number };
    // gespeichertes Passwort nur für denselben Server und Benutzer – nie an einen anderen Host schicken
    const stored = accounts.find((a) => a.nr === body.nr && a.host === body.host?.trim() && a.user === body.user?.trim());
    const password = body.password || stored?.password || "";
    if (!password) return c.json({ ok: false, folders: [], error: "Für einen anderen Server oder Benutzer das Passwort neu eingeben" });
    return c.json(await testConnection({ host: body.host, port: Number(body.port) || 993, user: body.user, password, folder: body.folder || "INBOX" }));
  })
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
  // eigenes Bild hochladen (multipart, Feld „file“) – ?featured=0: nicht gleich als Beitragsbild
  .post("/mails/:uid/images", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return c.json({ error: "Kein Bild übermittelt" }, 400);
    const data = Buffer.from(await file.arrayBuffer());
    return c.json(await pipeline.addImage(uid(c), { filename: file.name, contentType: file.type, data }, c.req.query("featured") !== "0"), 201);
  })
  .delete("/mails/:uid/images/:id", async (c) => c.json(await pipeline.removeImage(uid(c), c.req.param("id"))))
  .post("/mails/:uid/preview", async (c) => c.json(await pipeline.preview(uid(c), c.req.query("refresh") === "1")))
  .put("/mails/:uid/draft", async (c) => c.json(pipeline.saveDraft(uid(c), ArticleSchema.parse(await c.req.json()))))
  .post("/mails/:uid/publish", async (c) => c.json(await pipeline.publish(uid(c))))
  .post("/mails/:uid/skip", async (c) => {
    await pipeline.skip(uid(c));
    return c.json({ ok: true });
  })
  // Testlauf: Entwürfe zeigen – veröffentlicht nichts
  .post("/run", async (c) => c.json(await pipeline.run()))
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
      providers: LLM_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id], available: providerReady(cfg.llm, id) })),
      ...(await listModels(provider)),
    });
  })
  // Anbieter und Modell wechseln – gilt ab dem nächsten Entwurf bzw. Kalender-Abruf
  .put("/llm/model", async (c) => {
    const body = (await c.req.json()) as { model: string; provider?: LlmProvider };
    const provider = body.provider ?? cfg.llm.provider;
    if (!LLM_PROVIDERS.includes(provider)) return c.json({ error: `Unbekannter Anbieter „${provider}“` }, 400);
    if (!providerReady(cfg.llm, provider)) return c.json({ error: `Für ${PROVIDER_LABEL[provider]} fehlt der API-Key in der .env` }, 400);
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
    orte: loadQuellen(kalenderCfg.file).orte,
    last: lastKalender(),
  }))
  .post("/kalender/run", (c) => {
    const only = c.req.query("only")?.split(",").filter(Boolean);
    inBackground(() => runKalender(c.req.query("dryRun") === "1", only));
    return c.json({ started: true }, 202);
  })
  .post("/kalender/cancel", (c) => c.json({ cancelled: kalender.cancel() }))
  // Locations (Quellen vom Typ „seite“ / „regioactive“) anlegen, ändern, löschen
  .post("/kalender/quellen/erkennen", async (c) => {
    const { url, id } = (await c.req.json()) as { url: string; id?: string };
    return c.json(await erkennen(url, loadQuellen(kalenderCfg.file), id));
  })
  .post("/kalender/quellen", async (c) => {
    const input = (await c.req.json()) as LocationInput;
    return c.json(editQuellen(kalenderCfg.file, (q) => {
      const { quellen, quelle } = addLocation(q, input);
      return { quellen, result: quelle };
    }), 201);
  })
  .put("/kalender/quellen/:id", async (c) => {
    const input = (await c.req.json()) as LocationInput;
    return c.json(editQuellen(kalenderCfg.file, (q) => {
      const { quellen, quelle } = updateLocation(q, c.req.param("id"), input);
      return { quellen, result: quelle };
    }));
  })
  // Orte im Gebiet (Ort → Land) – Veranstalter wie Vaddi werden darauf beschränkt
  .put("/kalender/orte", async (c) => {
    const input = (await c.req.json()) as { name: string; land: string };
    return c.json(editQuellen(kalenderCfg.file, (q) => {
      const quellen = setOrt(q, input);
      return { quellen, result: quellen.orte };
    }));
  })
  .delete("/kalender/orte/:name", (c) =>
    c.json(editQuellen(kalenderCfg.file, (q) => {
      const quellen = removeOrt(q, c.req.param("name"));
      return { quellen, result: quellen.orte };
    })))
  .delete("/kalender/quellen/:id", (c) =>
    c.json(editQuellen(kalenderCfg.file, (q) => ({ quellen: removeLocation(q, c.req.param("id")), result: { ok: true } }))))
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
console.log(kalenderJob ? `Konzertkalender: „${kalenderCfg.schedule}“ – nächster ${at(kalenderJob)}` : "Konzertkalender: nur von Hand");
console.log("Veröffentlichen: nur nach deiner Freigabe im Dashboard");

export default {
  hostname: cfg.server.host,
  port: cfg.server.port,
  fetch: app.fetch,
  idleTimeout: 255, // Sprachmodell und Bild-Downloads können eine Weile dauern
};
