# Bühnenpost 🎸

**Pressemitteilungen & Konzertkalender für WordPress** – zwei Werkzeuge in einem Dashboard:

- **Postfach → Beiträge:** Musik-Pressemitteilungen aus dem Postfach werden zu eigenständigen, SEO-optimierten Beiträgen.
- **Konzertkalender:** Termine von Clubs, Veranstaltern und Ticketmaster im Raum Freiburg – Karlsruhe – Schweiz,
  abgeglichen und ohne Dubletten in WordPress, als Liste und Seitenleisten-Widget.

## Pressemitteilungen

Liest dein IMAP-Postfach nach Pressemitteilungen zu Musik (Tourdaten, Konzerte, Festivals,
Releases), lässt sie von einem **lokalen Sprachmodell** als eigenständigen, SEO-optimierten
Beitrag umschreiben und veröffentlicht sie über die WordPress-REST-API – **maximal 3
Beiträge pro Tag**. Läuft komplett auf deinem Mac, ohne API-Key und ohne laufende Kosten.

Mit **Vue-Dashboard** (Tailwind CSS, hell/dunkel): Postfach ansehen, Beiträge vorab generieren,
die **Original-Mail so sehen wie im Mailprogramm** (abgeschottet, ohne Skripte) samt **Prüfliste**
(Termine und Links aus der Mail gegen den Beitrag – fehlende, erfundene oder mit falschem Jahr fallen auf),
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

1. **Richtwert prüfen** – zählt die heute vom Bot-Benutzer angelegten Beiträge in WordPress.
   Ist `DAILY_LIMIT` erreicht, veröffentlicht der Zeitplan nichts mehr. Manuell im Dashboard
   („Veröffentlichen“, „Ausführen“) darfst du jederzeit mehr – der Wert ist nur ein Richtwert.
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

### Mehrere Postfächer und Dubletten

Weitere Postfächer kommen über `IMAP_2_USER`, `IMAP_2_PASSWORD` usw. in die `.env` (siehe
`.env.example`, bis zu 9). Fällt eins aus, laufen die anderen weiter; das Dashboard zeigt den Fehler.

Dieselbe Pressemitteilung in mehreren Postfächern wird **zusammengefasst** („2× erhalten“) –
auch wenn die Agentur sie einzeln verschickt hat (eigene Message-ID, persönliche Anrede, eigene
Klick-Zähler). Verglichen wird der Text ohne Links; bei abweichendem Betreff müssen zusätzlich
mindestens zwei Stichworte im Betreff übereinstimmen (meist Band und Album), damit Newsletter mit
gleicher Vorlage nicht zusammengeworfen werden. Veröffentlichen oder Überspringen erledigt alle
Exemplare. Kommt ein Exemplar erst später an, wird es automatisch als Dublette übersprungen
(steht im Verlauf).

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

- Eigenen Benutzer anlegen, z. B. `pressbot` mit der Rolle **Autor** (der Richtwert zählt
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
bun run start             # Dashboard bauen + Server mit Zeitplan → http://127.0.0.1:3210
```

Ohne Zugangsdaten ausprobieren (Beispiel-Mails, simuliertes WordPress): `DEMO=1 bun run start`

Für die ersten echten Läufe empfiehlt sich `WP_STATUS=draft`, um die Texte zu prüfen.

### 4. Automatisch beim Anmelden starten (optional)

```bash
sh scripts/autostart-macos.sh            # einrichten
sh scripts/autostart-macos.sh --remove   # wieder entfernen
```

## Konzertkalender

Eine Liste kommender Konzerte im Raum Freiburg – Karlsruhe – Schweiz auf der WordPress-Seite.
Der Abholer liest Veranstalter-Seiten, Vaddi Concerts und die Ticketmaster-API und schickt die
Termine an das Plugin [`wordpress/konzertkalender`](wordpress/konzertkalender/konzertkalender.php).
Jeder Termin hat Location, Künstler, Datum/Beginn und einen Freitext (Preis, Einlass, Support …).

```
Club-Seiten ──► Sprachmodell liest Termine ──┐
Vaddi Concerts ──► fester Parser ────────────┼──► Dubletten zusammenführen ──► WordPress-Plugin ──► [konzertkalender]
Ticketmaster Discovery API ──────────────────┘
```

**Einrichten**

1. `bun run kalender:plugin` erzeugt `wordpress/konzertkalender.zip` → in WordPress unter
   *Plugins → Installieren → Plugin hochladen* hochladen und aktivieren.
2. Auf einer Seite einen **Shortcode-Block** mit `[konzertkalender tage="90" filter="ja"]` einfügen.
   `filter="ja"` zeigt über der Liste eine **Textsuche** (Band, Künstler, Location, Infos – durchsucht das ganze
   Jahr), eine Auswahl nach **Monat** und nach **Ort**. Weitere Möglichkeiten: `land="DE,CH"`,
   `ort="Freiburg,Basel"`, `location="Jazzhaus"`, `limit="200"`.
   Unter der Liste steht ein **Haftungshinweis** („Alle Angaben ohne Gewähr … maßgeblich sind immer die Angaben des
   Veranstalters“), jeder Termin verlinkt „Infos & Tickets beim Veranstalter“. Eigener Text: `hinweis="…"`, ohne: `hinweis="aus"`.
   **Seitenleiste:** unter *Design → Widgets* das Widget „Konzertkalender“ hinzufügen (Anzahl, Zeitraum, Orte,
   Länder und Link „Alle Konzerte“ einstellbar) – oder überall kompakt per Shortcode:
   `[konzertkalender kompakt="ja" anzahl="8" link="/konzerte/"]`.
3. Optional einen kostenlosen Ticketmaster-Schlüssel holen ([developer.ticketmaster.com](https://developer.ticketmaster.com),
   „Consumer Key“) und als `TICKETMASTER_API_KEY` in die `.env` eintragen. Ohne Schlüssel wird Ticketmaster übersprungen.
4. Probelauf ohne Übertragen: `bun run kalender --dry-run` – einzelne Quellen: `bun run kalender --dry-run vaddi jazzhaus`.
5. Übertragen: `bun run kalender`. Täglich automatisch mit `KALENDER_AUTO=true` (Standard 6:30 Uhr,
   `KALENDER_SCHEDULE`), solange der Server läuft. Im Dashboard-Server auch über `POST /api/kalender/run`.

**Quellen** stehen in [`kalender/quellen.json`](kalender/quellen.json): neue Club-Seite mit
`"typ": "seite"`, Adresse, Location, Ort und Land eintragen – mehr braucht es nicht. Dort stehen auch das
Gebiet (Kreise für Ticketmaster), die Orte für Vaddi und Stichworte zum Ausschließen. Die Reihenfolge der
Quellen entscheidet bei Dubletten: Termine weiter oben bleiben, spätere Quellen ergänzen nur fehlende Angaben.

**Wie verlässlich ist das?**

- Das Sprachmodell darf nur Termine liefern, deren Datum und Künstler sich im Seitentext wiederfinden;
  Vergangenes fliegt raus. Trotzdem lohnt anfangs ein Blick – oder `KALENDER_STATUS=draft`, dann sind neue
  Termine in WordPress erst Entwurf.
- Fehlerhafte Termine in WordPress korrigieren und *„Nicht automatisch überschreiben“* anhaken – dann lässt
  der Abruf sie in Ruhe. Ausblenden: Termin auf Entwurf setzen, das bleibt beim nächsten Abruf so.
- Liefert eine Quelle keine Termine oder einen Fehler, bleiben ihre bisherigen Termine stehen. Sonst ersetzt jeder
  Abruf die künftigen Termine der Quelle (Abgesagtes verschwindet). Termine, die länger als 7 Tage vorbei sind,
  löscht das Plugin täglich.
- Vaddi veranstaltet auch Comedy und Lesungen; die werden anhand der Beschreibung aussortiert (Musik- gegen
  Bühnenprogramm-Begriffe). Grenzfälle wie Musikkabarett können in beide Richtungen fallen.
- Seiten, die ihr Programm per JavaScript nachladen oder eine Bot-Sperre haben, liefern keinen Text – dafür
  bräuchte es einen eigenen Weg. Die Festhalle Durlach ist deshalb nicht in der Liste.
- **Eventim/Ticketcorner** blocken automatisierte Abrufe und verbieten sie in den AGB – deshalb nicht dabei.
  Offiziell geht es nur über deren Partnerprogramm (Produkt-Feed).
- Ticketmaster erlaubt das Zwischenspeichern nur „für angemessene Zeit“ – der tägliche Abgleich hält die Daten aktuell.

**REST-API des Plugins** (Anwendungspasswort wie oben, Benutzer mit „Beiträge bearbeiten“):
`POST /wp-json/konzertkalender/v1/sync` mit `{ "source": "…", "replace": true, "events": [ … ] }`,
öffentlich lesbar: `GET /wp-json/konzertkalender/v1/events?tage=30&land=CH`.

## Weitere Befehle

| Befehl | Zweck |
|---|---|
| `bun run serve` | nur Server starten, ohne das Dashboard neu zu bauen |
| `bun run once` / `bun run once --dry-run` | einmaliger Lauf ohne Dashboard |
| `bun run kalender` / `--dry-run` | Konzertkalender abrufen und übertragen |
| `bun run kalender:plugin` | WordPress-Plugin als Zip zum Hochladen |
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
wordpress/   MU-Plugin für die SEO-Felder, Plugin „Konzertkalender“
kalender/    Quellen und Gebiet des Konzertkalenders (server/kalender/: Abholer)
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
