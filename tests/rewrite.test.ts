import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmEvents, type LlmEvent, type LlmTrace } from "../server/llm-events.ts";
import { Rewriter } from "../server/rewrite.ts";

const cfg = {
  provider: "ollama" as const, ollamaUrl: "http://ollama.test", ollamaModel: "gemma4",
  claudeModel: "", siteName: "Blog", siteTone: "locker", styleFile: "",
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
