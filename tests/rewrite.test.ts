import { afterEach, expect, spyOn, test } from "bun:test";
import { Rewriter } from "../server/rewrite.ts";

const cfg = {
  provider: "ollama" as const, ollamaUrl: "http://ollama.test", ollamaModel: "gemma4",
  claudeModel: "", siteName: "Blog", siteTone: "locker",
};
const mail = { uid: 1, messageId: "<1@test>", subject: "Band – Tour 2027", sender: "x", date: "", body: "Tourdaten …", images: [] };
const reply = (content: string) => new Response(JSON.stringify({ message: { content } }));
const article = JSON.stringify({
  relevant: true, reason: "", title: "Band Tour 2027", slug: "Band Tour", focus_keyword: "Band Tour 2027",
  meta_description: "Alle Termine.", excerpt: "", content_html: "<p>Hi</p><script>x</script>",
  category: "tourdaten", tags: ["Band"], image_credit: "",
});

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

test("Ollama: Schema wird mitgeschickt, Ergebnis wird bereinigt", async () => {
  const spy = spyOn(globalThis, "fetch").mockResolvedValue(reply(article));
  const result = await new Rewriter(cfg, ["News", "Tourdaten"]).rewrite(mail);

  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(init.body as string);
  expect(url).toBe("http://ollama.test/api/chat");
  expect(body.model).toBe("gemma4");
  expect(body.format.required).toContain("content_html");
  expect(result.category).toBe("Tourdaten");
  expect(result.slug).toBe("band-tour");
  expect(result.content_html).not.toContain("<script");
});

test("Ollama: bei kaputtem JSON wird einmal neu versucht", async () => {
  const spy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(reply("{kaputt"))
    .mockResolvedValueOnce(reply(article));
  const result = await new Rewriter(cfg, ["Tourdaten"]).rewrite(mail);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(result.title).toBe("Band Tour 2027");
});

test("Ollama nicht erreichbar: verständliche Fehlermeldung", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection refused"));
  expect(new Rewriter(cfg, ["News"]).rewrite(mail)).rejects.toThrow("läuft die Ollama-App?");
});
