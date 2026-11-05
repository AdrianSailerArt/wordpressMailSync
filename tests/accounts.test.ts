import { describe, expect, test } from "bun:test";
import { addAccount, guessServer, loadAccounts, removeAccount, toPublic, updateAccount, type MailAccount } from "../server/accounts.ts";
import { Store } from "../server/db.ts";
import { Mailboxes, mailId } from "../server/mail.ts";

const env = (user: string) => ({ name: user, host: "imap.example.com", port: 993, user, password: "geheim", folder: "INBOX", processedFolder: "" });
const input = { user: "neu@example.com", password: "pw", host: "imap.example.com" };

describe("Postfächer pflegen", () => {
  test("beim ersten Start aus der .env übernommen – danach zählt nur noch die Datenbank", () => {
    const store = new Store(":memory:");
    expect(loadAccounts(store, [env("a@x.de"), env("b@x.de")]).map((a) => [a.user, a.nr])).toEqual([["a@x.de", 0], ["b@x.de", 1]]);
    expect(loadAccounts(store, [env("andere@x.de")]).map((a) => a.user)).toEqual(["a@x.de", "b@x.de"]);
  });

  test("ohne Einträge in der .env: leer, nichts gespeichert", () => {
    const store = new Store(":memory:");
    expect(loadAccounts(store, [])).toEqual([]);
    expect(store.getSetting("mail_accounts")).toBeNull();
  });

  test("anlegen: Name = Adresse, Standards für Port und Ordner, keine Dubletten", () => {
    const store = new Store(":memory:");
    const list = addAccount(store, [], input);
    expect(list[0]).toEqual({ name: "neu@example.com", user: "neu@example.com", password: "pw", host: "imap.example.com", port: 993, folder: "INBOX", processedFolder: "", nr: 0 });
    expect(() => addAccount(store, list, { ...input, user: "NEU@example.com" })).toThrow("schon eingerichtet");
    expect(() => addAccount(store, [], { ...input, password: "" })).toThrow("Passwort fehlt");
    expect(() => addAccount(store, [], { ...input, host: "" })).toThrow("IMAP-Server fehlt");
  });

  test("Nummern werden nie neu vergeben – alte Mail-IDs zeigen nicht aufs falsche Postfach", () => {
    const store = new Store(":memory:");
    let list = addAccount(store, [], input);
    list = addAccount(store, list, { ...input, user: "zwei@example.com" });
    list = removeAccount(store, list, 1);
    list = addAccount(store, list, { ...input, user: "drei@example.com" });
    expect(list.map((a) => a.nr)).toEqual([0, 2]);
  });

  test("bearbeiten: leeres Passwort behält das alte", () => {
    const store = new Store(":memory:");
    const list = updateAccount(addAccount(store, [], input), 0, { ...input, password: "", folder: "Presse" });
    expect(list[0]).toMatchObject({ password: "pw", folder: "Presse", nr: 0 });
  });

  test("fürs Dashboard ohne Passwort", () => {
    const pub = toPublic({ ...env("a@x.de"), nr: 0 });
    expect("password" in pub).toBe(false);
    expect(pub.hasPassword).toBe(true);
  });
});

describe("IMAP-Server erkennen", () => {
  test("bekannte Anbieter ohne DNS", async () => {
    expect(await guessServer("redaktion@gmail.com")).toEqual({ host: "imap.gmail.com", port: 993, quelle: "Anbieter" });
    expect((await guessServer("x@web.de"))?.host).toBe("imap.web.de");
    expect((await guessServer("x@gmx.de"))?.host).toBe("imap.gmx.net");
    expect(await guessServer("keine-adresse")).toBeNull();
  });
});

describe("Mailboxes", () => {
  const account = (nr: number, name: string): MailAccount => ({ ...env(name), nr });

  test("Status trägt die feste Nummer, Postfächer lassen sich zur Laufzeit tauschen", () => {
    const boxes = new Mailboxes([account(0, "a"), account(3, "b")], 7);
    expect(boxes.status().map((s) => [s.nr, s.name])).toEqual([[0, "a"], [3, "b"]]);
    boxes.setAccounts([account(3, "b")]);
    expect(boxes.status().map((s) => s.nr)).toEqual([3]);
  });

  test("Mail aus einem gelöschten Postfach: verständlicher Fehler", async () => {
    const boxes = new Mailboxes([account(3, "b")], 7);
    await expect(boxes.get(mailId(0, 42))).rejects.toThrow("nicht mehr eingerichtet");
  });

  test("ohne Postfach: Hinweis auf die Einstellungen", async () => {
    await expect(new Mailboxes([], 7).candidates()).rejects.toThrow("Einstellungen");
  });
});

test("Postfach auf anderen Server umziehen: Passwort neu eingeben", () => {
  const store = new Store(":memory:");
  const list = addAccount(store, [], input);
  expect(() => updateAccount(list, 0, { ...input, password: "", host: "imap.anders.example" })).toThrow("Passwort neu eingeben");
  expect(updateAccount(list, 0, { ...input, password: "neu", host: "imap.anders.example" })[0]?.password).toBe("neu");
});
