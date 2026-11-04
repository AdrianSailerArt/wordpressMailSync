import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmEvents, type LlmEvent, type LlmTrace } from "../server/llm-events.ts";
import type { LlmProvider } from "../server/config.ts";
import { CancelledError, extractJson, generateJson, isLooping, Rewriter } from "../server/rewrite.ts";

const cfg = {
  provider: "ollama" as LlmProvider, ollamaUrl: "http://ollama.test", ollamaModel: "gemma4",
  mlxUrl: "http://mlx.test", mlxModel: "mlx-community/gemma-4-e4b-it-4bit",
  opencodeUrl: "http://opencode.test", opencodeModel: "opencode/big-pickle",
  openaiUrl: "http://openai.test/v1", openaiKey: "sk-test", openaiModel: "gpt-5.4-mini", claudeModel: "", claudeKey: false, siteName: "Blog", siteTone: "locker", styleFile: "",
};
const mail = { uid: 1, messageId: "<1@test>", subject: "Band – Tour 2027", sender: "x", date: "", body: "Tourdaten …", images: [] };
const reply = (content: string) => new Response(JSON.stringify({ message: { content } }));
const music = JSON.stringify({ artist: "Band", music_news: true, reason: "Tour" });
const article = JSON.stringify({
  relevant: true, reason: "", title: "Band Tour 2027", slug: "Band Tour", focus_keyword: "Band Tour 2027",
  meta_description: "Alle Termine.", excerpt: "", content_html: "<p>Hi</p><script>x</script>",
  category: "tourdaten", tags: ["Band"], image_credit: "",
});

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const body = (spy: { mock: { calls: unknown[][] } }, i: number) => JSON.parse((spy.mock.calls[i]![1] as RequestInit).body as string);

test("erst Musik-Prüfung, dann Beitrag – Schema wird mitgeschickt, Ergebnis bereinigt", async () => {
  const spy = spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(music)).mockResolvedValueOnce(reply(article));
  const result = await new Rewriter(cfg, ["News", "Tourdaten"]).rewrite(mail);

  expect(spy.mock.calls[0]![0]).toBe("http://ollama.test/api/chat");
  expect(body(spy, 0).format.required).toContain("music_news");
  expect(body(spy, 1).format.required).toContain("content_html");
  expect(body(spy, 1).format.required).not.toContain("featured_image");
  expect(result.category).toBe("Tourdaten");
  expect(result.slug).toBe("band-tour");
  expect(result.content_html).not.toContain("<script");
});

test("keine Musik (z. B. Technik-Pressemitteilung): kein Beitrag, nur ein Modellaufruf", async () => {
  const spy = spyOn(globalThis, "fetch").mockResolvedValue(
    reply(JSON.stringify({ artist: "", music_news: false, reason: "Bluetooth-Chip" })));
  const result = await new Rewriter(cfg, ["News"]).rewrite({ ...mail, subject: "Nordic Semiconductor: Bluetooth" });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(result.relevant).toBe(false);
  expect(result.reason).toContain("Bluetooth-Chip");
});

test("Musik ohne benannten Künstler zählt nicht", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(reply(JSON.stringify({ artist: " ", music_news: true, reason: "Release" })));
  expect((await new Rewriter(cfg, ["News"]).rewrite(mail)).relevant).toBe(false);
});

test("bei kaputtem JSON wird einmal neu versucht", async () => {
  const spy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(reply(music))
    .mockResolvedValueOnce(reply("{kaputt"))
    .mockResolvedValueOnce(reply(article));
  const result = await new Rewriter(cfg, ["Tourdaten"]).rewrite(mail);
  expect(spy).toHaveBeenCalledTimes(3);
  expect(result.title).toBe("Band Tour 2027");
});

test("Stil-Regelwerk wird an die Schreib-Anweisung angehängt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wms-stil-"));
  try {
    const file = join(dir, "regelwerk.md");
    writeFileSync(file, "- Wir duzen die Leser:innen.");
    const spy = spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(music)).mockResolvedValueOnce(reply(article));
    await new Rewriter({ ...cfg, styleFile: file }, ["News"]).rewrite(mail);
    expect(body(spy, 1).messages[0].content).toContain("Wir duzen die Leser:innen.");
    expect(body(spy, 0).messages[0].content).not.toContain("Wir duzen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ollama nicht erreichbar: verständliche Fehlermeldung", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection refused"));
  expect(new Rewriter(cfg, ["News"]).rewrite(mail)).rejects.toThrow("läuft die Ollama-App?");
});

/** Ollama-Antwort als Datenstrom: mehrere Textstücke, zum Schluss die Messwerte. */
const streamed = (content: string) => {
  const parts = content.match(/.{1,7}/gs) ?? [];
  const lines = parts.map((p) => JSON.stringify({ message: { content: p }, done: false }));
  lines.push(JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 120, eval_count: 40, eval_duration: 2e9 }));
  return new Response(lines.join("\n") + "\n");
};

test("Live-Ausgabe: Textstücke, Messwerte und vollständiges Protokoll", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(streamed(music)).mockResolvedValueOnce(streamed(article));
  const events = new LlmEvents();
  const seen: LlmEvent[] = [];
  events.subscribe((e) => seen.push(e));
  let trace: LlmTrace | null = null;

  const result = await new Rewriter(cfg, ["News"], { events, onTrace: (t) => (trace = t) }).rewrite(mail);

  expect(result.generated_by).toBe("gemma4");
  expect(seen.filter((e) => e.type === "token").length).toBeGreaterThan(10);
  expect(seen.map((e) => e.type).filter((t) => t !== "token")).toEqual(["start", "end", "start", "end", "result"]);
  expect(trace!.stages.map((s) => s.stage)).toEqual(["check", "write"]);
  expect(trace!.stages[1]!.raw).toBe(article);
  expect(trace!.stages[1]!.stats).toMatchObject({ promptTokens: 120, outputTokens: 40, tokensPerSec: 20 });
  expect(events.active()).toEqual([]);
});

test("Modell lässt sich zur Laufzeit wechseln", async () => {
  const spy = spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(music)).mockResolvedValueOnce(reply(article));
  let chosen = "qwen3:8b";
  const rw = new Rewriter(cfg, ["News"], { model: () => chosen });
  expect(rw.model).toBe("qwen3:8b");
  const result = await rw.rewrite(mail);
  expect(body(spy, 0).model).toBe("qwen3:8b");
  expect(body(spy, 1).model).toBe("qwen3:8b");
  expect(result.generated_by).toBe("qwen3:8b");
  chosen = "";
  expect(rw.model).toBe("gemma4"); // ohne Auswahl gilt OLLAMA_MODEL
});

test("Fehler im Lauf: Protokoll enthält den Fehler, Live-Anzeige wird beendet", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(music)).mockResolvedValueOnce(new Response("kaputt", { status: 500 }));
  const events = new LlmEvents();
  let trace: LlmTrace | null = null;
  expect(new Rewriter(cfg, ["News"], { events, onTrace: (t) => (trace = t) }).rewrite(mail)).rejects.toThrow("Ollama: 500");
  await Bun.sleep(10);
  expect(trace!.stages[1]!.error).toContain("Ollama: 500");
  expect(events.active()).toEqual([]);
});

/** Antwort von mlx_lm.server als Server-Sent Events (OpenAI-Format) */
const mlxStream = (content: string) => {
  const parts = content.match(/.{1,7}/gs) ?? [];
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}`);
  lines.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 90, completion_tokens: 30 } })}`, "data: [DONE]");
  return new Response(lines.join("\n\n") + "\n\n");
};
const mlx = { ...cfg, provider: "mlx" as LlmProvider };

test("MLX: OpenAI-Schnittstelle, Schema in der Anweisung, Markdown-Zaun wird entfernt", async () => {
  const spy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(mlxStream("```json\n" + music + "\n```"))
    .mockResolvedValueOnce(mlxStream(`Hier der Beitrag:\n${article}`));
  let trace: LlmTrace | null = null;
  const rw = new Rewriter(mlx, ["News"], { events: new LlmEvents(), onTrace: (t) => (trace = t) });
  expect(rw.model).toBe("mlx-community/gemma-4-e4b-it-4bit");
  const result = await rw.rewrite(mail);

  expect(String(spy.mock.calls[0]![0])).toBe("http://mlx.test/v1/chat/completions");
  const req = body(spy, 1);
  expect(req.model).toBe("mlx-community/gemma-4-e4b-it-4bit");
  expect(req.stream).toBe(true);
  expect(req.max_tokens).toBeGreaterThan(512);
  expect(req.messages[0].content).toContain('"content_html"'); // Schema steht in der Anweisung
  expect(result.relevant).toBe(true);
  expect(result.title).toBe("Band Tour 2027");
  expect(trace!.stages[1]!.stats).toMatchObject({ promptTokens: 90, outputTokens: 30 });
});

test("MLX: kaputtes JSON beim Herauslesen wird einmal neu angefragt", async () => {
  const spy = spyOn(globalThis, "fetch").mockResolvedValueOnce(mlxStream("{ kaputt")).mockResolvedValueOnce(mlxStream('{"events":[]}'));
  expect(await generateJson(mlx, "m", "sys", "text", { type: "object" })).toEqual({ events: [] });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(body(spy, 0).temperature).toBe(0);
});

test("MLX nicht erreichbar: verständliche Fehlermeldung", async () => {
  spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
  expect(generateJson(mlx, "m", "sys", "text", {})).rejects.toThrow("läuft mlx_lm.server?");
});

test("extractJson: Text und Zäune um das Objekt herum fallen weg", () => {
  expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(extractJson('Antwort: {"a":{"b":2}} Fertig.')).toBe('{"a":{"b":2}}');
  expect(extractJson("kein json")).toBe("kein json");
});

/** Ollama-Antwort, die nach dem ersten Stück hängen bleibt, bis der Aufruf abgebrochen wird */
const hanging = (signal: AbortSignal) => new Response(new ReadableStream({
  start(ctrl) {
    ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "{\"rel" }, done: false }) + "\n"));
    signal.addEventListener("abort", () => ctrl.error(signal.reason));
  },
}));

test("Abbrechen stoppt die laufende Generierung", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(music))
    .mockImplementationOnce(((_: unknown, init: RequestInit) => Promise.resolve(hanging(init.signal!))) as unknown as typeof fetch);
  const events = new LlmEvents();
  let trace: LlmTrace | null = null;
  const rw = new Rewriter(cfg, ["News"], { events, onTrace: (t) => (trace = t) });
  expect(rw.cancel()).toBe(false); // nichts läuft
  const running = rw.rewrite(mail);
  await Bun.sleep(20);
  expect(rw.cancel()).toBe(true);
  expect(running).rejects.toBeInstanceOf(CancelledError);
  await Bun.sleep(10);
  expect(trace!.reason).toBe("Abgebrochen");
  expect(trace!.stages[1]!.error).toBe("abgebrochen");
  expect(events.active()).toEqual([]);
  expect(rw.cancel()).toBe(false);
});

test("läuft das Modell ins Leere, wird abgebrochen und einmal neu gefragt", async () => {
  const blank = (signal: AbortSignal) => new Response(new ReadableStream({
    start(ctrl) {
      // nur noch Zeilenumbrüche – typisches Festlaufen im JSON-Modus
      for (let i = 0; i < 100; i++) ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "{ " + "\n".repeat(i ? 20 : 0) }, done: false }) + "\n"));
      signal.addEventListener("abort", () => ctrl.error(signal.reason));
    },
  }));
  const spy = spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(music))
    .mockImplementationOnce(((_: unknown, init: RequestInit) => Promise.resolve(blank(init.signal!))) as unknown as typeof fetch)
    .mockResolvedValueOnce(reply(article));
  const result = await new Rewriter(cfg, ["News"]).rewrite(mail);
  expect(spy).toHaveBeenCalledTimes(3);
  expect(result.title).toBe("Band Tour 2027");
});

test("isLooping: Leerlauf und Dauerschleifen, normaler Text nicht", () => {
  const prose = "Die Band kommt 2027 auf Tour und spielt in Freiburg, Basel und Karlsruhe. ";
  expect(isLooping("{" + " \n".repeat(400))).toBe(true);
  expect(isLooping('{"tags": ["Tour", ' + '"Tour 2027", '.repeat(80))).toBe(true);
  expect(isLooping(prose.repeat(12))).toBe(true); // derselbe Satz immer wieder
  expect(isLooping(Array.from({ length: 30 }, (_, i) => `Termin ${i + 1}: ${10 + i}.03.2027 – Stadt ${i}`).join("\n"))).toBe(false);
  expect(isLooping("kurz")).toBe(false);
});

/** lokaler OpenCode-Server: Antworten je Pfad, Ereignis-Strom mit den angegebenen Ereignissen */
function opencodeServer(events: object[], message: object | null) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/session" && method === "POST") return new Response(JSON.stringify({ id: "ses_1" }));
    if (path === "/event") {
      const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(lines));
          init!.signal!.addEventListener("abort", () => ctrl.close());
        },
      }));
    }
    if (path.endsWith("/message")) {
      // auf ein Limit wartet OpenCode – hier: hängen bis zum Abbruch
      if (!message) return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      await Bun.sleep(5);
      return new Response(JSON.stringify(message));
    }
    return new Response("true");
  }) as unknown as typeof fetch);
  return { calls, spy };
}
const oc = { ...cfg, provider: "opencode" as LlmProvider, opencodeModel: "opencode/big-pickle" };

test("OpenCode lokal: Sitzung ohne Werkzeuge, JSON nach Schema, fremde Sitzungen ignoriert, danach aufgeräumt", async () => {
  const delta = (d: string) => ({ type: "session.next.text.delta", properties: { sessionID: "ses_1", delta: d } });
  const { calls } = opencodeServer(
    [delta('{"artist":'), { type: "session.next.text.delta", properties: { sessionID: "anders", delta: "fremd" } }, delta('"Band"}')],
    { info: { structured: JSON.parse(music), tokens: { input: 50, output: 20 } }, parts: [] },
  );
  expect(new Rewriter(oc, ["News"]).model).toBe("opencode/big-pickle");
  const raw = await generateJson(oc, "opencode/big-pickle", "sys", "text", { type: "object" });
  expect(raw).toEqual(JSON.parse(music));

  const msg = calls.find((c) => c.path === "/session/ses_1/message")!;
  expect(msg.body.model).toEqual({ providerID: "opencode", modelID: "big-pickle" });
  expect(msg.body.tools).toEqual({ "*": false });
  expect(msg.body.format.type).toBe("json_schema");
  expect(msg.body.system).toBe("sys");
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/session/ses_1")).toBe(true);
});

test("OpenCode: Limit („retry“) bricht sofort mit verständlicher Meldung ab", async () => {
  const { calls } = opencodeServer(
    [{ type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go" } } }],
    null,
  );
  expect(generateJson(oc, "opencode/big-pickle", "sys", "text", {})).rejects.toThrow("Free usage exceeded");
  await Bun.sleep(30);
  expect(calls.some((c) => c.path === "/session/ses_1/abort")).toBe(true);
});

test("OpenCode: Live-Textstücke landen in der Live-Ausgabe", async () => {
  const delta = (d: string) => ({ type: "session.next.text.delta", properties: { sessionID: "ses_1", delta: d } });
  opencodeServer([delta("Hallo "), delta("Welt")], { info: { structured: JSON.parse(music) }, parts: [] });
  const tokens: string[] = [];
  const events = new LlmEvents();
  events.subscribe((e) => e.type === "token" && tokens.push(e.text));
  // Stufe 1 (Musik-Prüfung) reicht; Stufe 2 bekommt dieselbe Antwort und scheitert an der Prüfung – egal hier
  await new Rewriter(oc, ["News"], { events }).rewrite(mail).catch(() => undefined);
  expect(tokens.join("")).toContain("Hallo Welt");
});

test("ChatGPT (OpenAI-API): Bearer-Key, JSON-Schema, keine Temperatur, Live-Text", async () => {
  const gpt = { ...cfg, provider: "openai" as LlmProvider };
  const spy = spyOn(globalThis, "fetch").mockResolvedValueOnce(mlxStream(music)).mockResolvedValueOnce(mlxStream(article));
  const tokens: string[] = [];
  const events = new LlmEvents();
  events.subscribe((e) => e.type === "token" && tokens.push(e.text));
  const rw = new Rewriter(gpt, ["News"], { events });
  expect(rw.model).toBe("gpt-5.4-mini");
  const result = await rw.rewrite(mail);

  expect(String(spy.mock.calls[0]![0])).toBe("http://openai.test/v1/chat/completions");
  expect(((spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  const req = body(spy, 1);
  expect(req.model).toBe("gpt-5.4-mini");
  expect(req.response_format.type).toBe("json_schema");
  expect(req.temperature).toBeUndefined();
  expect(req.max_completion_tokens).toBeGreaterThan(4000);
  expect(result.title).toBe("Band Tour 2027");
  expect(tokens.join("")).toContain("Band Tour 2027");
});

test("ChatGPT: ungültiger Key gibt eine verständliche Meldung", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }));
  expect(generateJson({ ...cfg, provider: "openai" as LlmProvider }, "gpt-5.4-mini", "s", "u", {})).rejects.toThrow("API-Key ungültig");
});
