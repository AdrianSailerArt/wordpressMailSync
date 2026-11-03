# WordPress Mail Sync 🎸

Liest dein IMAP-Postfach nach Pressemitteilungen zu Musik (Tourdaten, Konzerte, Festivals,
Releases), lässt sie von einem **lokalen Sprachmodell** als eigenständigen, SEO-optimierten
Beitrag umschreiben und veröffentlicht sie über die WordPress-REST-API – **maximal 3
Beiträge pro Tag**. Läuft komplett auf deinem Mac, ohne API-Key und ohne laufende Kosten.

Mit **Vue-Dashboard** (Tailwind CSS, hell/dunkel): Postfach ansehen, Beiträge vorab generieren,
generierten Text **wortweise mit der Original-Mail vergleichen**, Titel/Meta/Text bearbeiten,
**Thumbnail und Bilder auswählen**, gezielt veröffentlichen oder überspringen, Verlauf aller Aktionen.

**10× am Tag** wird automatisch ein Vorschlag erzeugt – du bekommst eine
**Chrome-Benachrichtigung** und entscheidest im Dashboard, ob er online geht.

**Stack:** [Bun](https://bun.sh) + TypeScript · Hono · bun:sqlite · Vue 3 + Vite + Tailwind CSS ·
[Ollama](https://ollama.com) (gemma4) – optional Claude-API

## So funktioniert's

```
IMAP-Postfach ──► Vorfilter ──► Ollama: relevant? + Umschreiben ──► (Dashboard: prüfen/bearbeiten) ──► WordPress
      ▲                                                                                                  │
      └──────────────── Mail wird per IMAP-Keyword als erledigt/übersprungen markiert ◄──────────────────┘
```

1. **Tageslimit prüfen** – zählt die heute vom Bot-Benutzer angelegten Beiträge in WordPress.
   Ist `DAILY_LIMIT` erreicht, passiert nichts (gilt auch für Klicks im Dashboard).
2. **Mails holen** – alle unbearbeiteten Mails der letzten `MAX_AGE_DAYS` Tage, neueste
   zuerst. Der Gelesen-Status bleibt unverändert.
3. **Vorfilter** – Mails ohne Musik-Stichworte werden ohne KI-Aufruf übersprungen.
4. **Sprachmodell, Stufe 1** – strenge Prüfung „Geht es um konkrete Musiker, Bands oder
   Festivals?“ (≈ 10 s). Technik-, Wirtschafts- und Startup-Meldungen fliegen hier raus.
5. **Sprachmodell, Stufe 2** – schreibt den Beitrag nach dem
   [Stil-Regelwerk](stil/regelwerk.md): Titel im Hausformat, SEO-Titel, Meta-Description,
   Fokus-Keyword, Zwischenüberschriften, Tourdaten, Kategorie und Tags (≈ 30–60 s).
6. **Bilder** – Anhänge, eingebettete und verlinkte Bilder der Mail werden gesammelt; Logos,
   Icons, Banner und Tracking-Pixel fliegen nach Größe raus. Das größte Bild wird Thumbnail,
   im Dashboard lässt sich das ändern und weitere Bilder in den Text einfügen.
   **YouTube-Videos** werden erkannt – auch hinter Klick-Zählern von Newsletter-Diensten – und
   **cookiefrei** eingebunden: eigenes Vorschaubild in der Mediathek, verlinkt auf YouTube. Beim
   Seitenaufruf wird nichts von Google geladen. Standard: das erste Video der Mail.
7. **Link-Filter** – Download-, Presseordner- und Hörproben-Links (WeTransfer, Dropbox, private
   SoundCloud-Links, ZIP/MP3/PDF …) sowie YouTube-URLs werden aus dem Text entfernt.
8. **WordPress** – Beitrag mit Kategorie, Tags, Auszug, Yoast-Feldern, Beitragsbild und
   optional Bildern im Text.
9. **Merken** – erledigte Mails stehen in der lokalen Datenbank (zusätzlich IMAP-Keyword, wo
   der Server das erlaubt) – nichts wird doppelt verarbeitet.

### Zeitpläne

| Was | Standard | Einstellung |
|---|---|---|
| Vorschlag erzeugen + Chrome-Benachrichtigung | 10× täglich (8, 9, 11, 12, 14, 15, 17, 18, 20, 21 Uhr) | `SUGGEST_SCHEDULE` |
| Automatisch veröffentlichen (max. 1 pro Lauf, 3 pro Tag) | 8, 13, 18 Uhr | `SCHEDULE`, abschalten mit `AUTO_PUBLISH=false` |

**Der Mac muss dafür an und wach sein**; verpasste Läufe werden nicht nachgeholt. Im
Dashboard lassen sich beide jederzeit von Hand auslösen („Vorschlag“, „Ausführen“).

### Chrome-Benachrichtigungen

Im Dashboard oben auf die **Glocke** klicken und Benachrichtigungen erlauben – es kommt sofort
eine Test-Nachricht. Danach meldet sich Chrome bei jedem neuen Vorschlag, auch wenn das
Dashboard-Tab geschlossen ist (Chrome muss laufen). Ein Klick öffnet direkt den Vorschlag.

## Einrichtung

### 1. Voraussetzungen

- [Bun](https://bun.sh) und die [Ollama-App](https://ollama.com) (muss laufen)
- Modell laden: `ollama pull gemma4`

### 2. WordPress vorbereiten

- Eigenen Benutzer anlegen, z. B. `pressbot` mit der Rolle **Autor** (das Tageslimit zählt
  die Beiträge dieses Benutzers).
- Als dieser Benutzer: *Profil → Anwendungspasswörter* → neues Passwort erzeugen.
- Für SEO-Felder: [`wordpress/pressbot-seo-meta.php`](wordpress/pressbot-seo-meta.php) nach
  `wp-content/mu-plugins/` kopieren und `SEO_PLUGIN=yoast` oder `rankmath` setzen.
- Kategorien über den Slug zuordnen, weil Namen wie „News“ oft mehrfach vorkommen:
  `WP_CATEGORIES=News=music-news,Events=events`.
- Liefert die REST-API trotz Anwendungspasswort „rest_login_required“, reicht der Server die
  Anmeldung nicht weiter (z. B. bei DomainFactory). Dann am Anfang der `.htaccess` ergänzen:
  ```apache
  SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
  <IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
  </IfModule>
  ```

### 3. Starten

```bash
bun install
cp .env.example .env      # IMAP- und WordPress-Zugang eintragen
bun run build             # Vue-Dashboard bauen
bun run start             # Server + Zeitplan → http://127.0.0.1:3210
```

Ohne Zugangsdaten ausprobieren (Beispiel-Mails, simuliertes WordPress): `DEMO=1 bun run start`

Für die ersten echten Läufe empfiehlt sich `WP_STATUS=draft`, um die Texte zu prüfen.

### 4. Automatisch beim Anmelden starten (optional)

```bash
sh scripts/autostart-macos.sh            # einrichten
sh scripts/autostart-macos.sh --remove   # wieder entfernen
```

## Weitere Befehle

| Befehl | Zweck |
|---|---|
| `bun run once` / `bun run once --dry-run` | einmaliger Lauf ohne Dashboard |
| `bun run dev` | Entwicklung mit Hot-Reload (Dashboard auf :5173) |
| `bun test` · `bun run typecheck` | Tests und Typprüfung |

## Modell wechseln und zuschauen

- **Einstellungen → Sprachmodell** listet alle in Ollama installierten Modelle (Größe,
  Quantisierung, ob gerade geladen, Warnung bei zu wenig Arbeitsspeicher). Ein Klick schaltet
  um, die Wahl gilt ab dem nächsten Entwurf und bleibt gespeichert. `OLLAMA_MODEL` ist nur
  der Standard.
- Während ein Entwurf entsteht, zeigt das Dashboard **live**, was das Modell schreibt (Stufe,
  Zeichen, Zeit) – auch bei Läufen aus dem Zeitplan. In der Kopfzeile steht dann „schreibt …“.
- Reiter **KI** im Editor: das Protokoll beider Stufen mit Anweisung, Eingabe, Rohantwort,
  Dauer, Tokens und Geschwindigkeit. Jeder Entwurf merkt sich, welches Modell ihn geschrieben hat.
- Erfahrung: `gemma3:4b` ist nicht schneller fertig als `gemma4` und schreibt teils auf Englisch.
- Claude statt lokal: `LLM_PROVIDER=claude` und `ANTHROPIC_API_KEY` setzen.

## Stil-Regelwerk

[`stil/regelwerk.md`](stil/regelwerk.md) beschreibt, wie die Redaktion schreibt (Ansprache,
Einstieg, Aufbau je Meldungsart, Titelformate, Termine, Links). Es wurde aus Artikeln von
tribe-online.de abgeleitet und wird jedem Schreibauftrag mitgegeben. Einfach bearbeiten und
den Server neu starten; anderer Pfad über `STYLE_FILE`.

## Projektstruktur

```
server/      Bun-Backend: config, mail (IMAP), images (Bilder), rewrite (Ollama/Claude), llm-events
             (Live-Ausgabe/Protokoll), wordpress, pipeline, push, db, index (API + Zeitpläne), cli, demo
stil/        Stil-Regelwerk der Redaktion
web/         Vue-3-Dashboard (Vite, Tailwind) inkl. Service Worker für Push
tests/       bun test
scripts/     Autostart für macOS
wordpress/   MU-Plugin für die SEO-Felder
```

## Hinweise

- Pressefotos werden mit dem Fotocredit aus der Mail als Bildunterschrift gesetzt; prüfe bei
  Bedarf die Nutzungsbedingungen der Agentur. Download-Links (WeTransfer, Dropbox …) zeigt das
  Dashboard an, lädt sie aber nicht automatisch.
- Beim Laden verlinkter Bilder sieht der Absender ggf., dass die Mail „geöffnet“ wurde
  (wie bei jedem Mailprogramm, das Bilder anzeigt). Beim Auflösen von Video-Links hinter
  Klick-Zählern zählt der Newsletter-Dienst einen „Klick“.
- Ältere Beiträge auf tribe-online.de binden YouTube per URL ein; Jetpack lädt den Player dann
  sofort beim Seitenaufruf (Cookies ohne Einwilligung). Der Cookie-Hinweis „Simple Cookie
  Notice Bar“ blockiert das nicht. Neue Beiträge aus diesem Tool sind davon nicht betroffen.
- E-Mail-Inhalte gelten als nicht vertrauenswürdig: Das Modell ist angewiesen, Anweisungen in
  Mails zu ignorieren, und das erzeugte HTML wird vor dem Veröffentlichen auf eine
  Tag-Whitelist bereinigt.
- Lokale Modelle sind schwächer als große Cloud-Modelle – gerade am Anfang lohnt sich ein
  Blick ins Dashboard, bevor veröffentlicht wird.
- Das Dashboard lauscht nur auf `127.0.0.1` (nur dein Mac). Wer es im Netzwerk freigibt,
  setzt `DASHBOARD_PASSWORD`.
