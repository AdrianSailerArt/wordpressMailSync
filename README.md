# WordPress Mail Sync 🎸

Liest dein IMAP-Postfach nach Pressemitteilungen zu Musik (Tourdaten, Konzerte, Festivals,
Releases), lässt sie von Claude als eigenständigen, SEO-optimierten Beitrag umschreiben und
veröffentlicht sie über die WordPress-REST-API – **maximal 3 Beiträge pro Tag**.

Mit **Vue-Dashboard**: Postfach ansehen, Beiträge vorab generieren, Titel/Meta/Text
bearbeiten, gezielt veröffentlichen oder überspringen, Verlauf aller Aktionen.

**Stack:** [Bun](https://bun.sh) + TypeScript · Hono · bun:sqlite · Vue 3 + Vite · Claude API

## So funktioniert's

```
IMAP-Postfach ──► Vorfilter ──► Claude: relevant? + Umschreiben ──► (Dashboard: prüfen/bearbeiten) ──► WordPress
      ▲                                                                                                  │
      └──────────────── Mail wird per IMAP-Keyword als erledigt/übersprungen markiert ◄──────────────────┘
```

1. **Tageslimit prüfen** – zählt die heute vom Bot-Benutzer angelegten Beiträge in WordPress.
   Ist `DAILY_LIMIT` erreicht, passiert nichts (gilt auch für Klicks im Dashboard).
2. **Mails holen** – alle unbearbeiteten Mails der letzten `MAX_AGE_DAYS` Tage, neueste
   zuerst. Der Gelesen-Status bleibt unverändert.
3. **Vorfilter** – Mails ohne Musik-Stichworte werden ohne KI-Aufruf übersprungen.
4. **Claude** prüft die Relevanz und schreibt neu: eigener Text, Fakten exakt übernommen,
   Fokus-Keyword, SEO-Titel (≤ 60 Zeichen), Meta-Description, Slug, Zwischenüberschriften,
   Tourdaten als Liste, Kategorie und Tags. Entwürfe werden zwischengespeichert.
5. **WordPress** – Beitrag mit Kategorie, Tags, Auszug, SEO-Meta (Yoast/Rank Math) und dem
   größten Bild-Anhang als Beitragsbild.
6. **Markieren** – IMAP-Keyword `$PressbotDone` bzw. `$PressbotSkipped` (optional zusätzlich
   in `IMAP_PROCESSED_FOLDER` verschoben) – nichts wird doppelt verarbeitet.

Der eingebaute Zeitplan (`SCHEDULE`, Standard 8/13/18 Uhr) veröffentlicht pro Lauf einen
Beitrag (`POSTS_PER_RUN=1`) → drei Beiträge über den Tag verteilt.

## Einrichtung

### 1. WordPress vorbereiten

- Eigenen Benutzer anlegen, z. B. `pressbot` mit der Rolle **Autor** (das Tageslimit zählt
  die Beiträge dieses Benutzers).
- Als dieser Benutzer: *Profil → Anwendungspasswörter* → neues Passwort erzeugen.
- Für SEO-Felder: [`wordpress/pressbot-seo-meta.php`](wordpress/pressbot-seo-meta.php) nach
  `wp-content/mu-plugins/` kopieren und `SEO_PLUGIN=yoast` oder `rankmath` setzen.

### 2. Lokal starten

```bash
bun install
cp .env.example .env      # Werte eintragen
bun run build             # Vue-Dashboard bauen
bun run start             # Server + Zeitplan → http://127.0.0.1:3000
```

Ohne Zugangsdaten ausprobieren (Beispiel-Mails, simuliertes WordPress):

```bash
DEMO=1 bun run start
```

Entwicklung mit Hot-Reload: `bun run dev` → Dashboard auf http://localhost:5173.

Für die ersten echten Läufe empfiehlt sich `WP_STATUS=draft`, um die Texte zu prüfen.

### 3. Dauerhaft auf einem Server (empfohlen)

```bash
docker build -t wordpress-mail-sync .
docker run -d --name wms --env-file .env -p 3000:3000 -v wms-data:/app/data wordpress-mail-sync
```

**Wichtig:** Ist das Dashboard aus dem Internet erreichbar, `DASHBOARD_PASSWORD` setzen
(Login: `admin`) und am besten hinter einen Reverse-Proxy mit HTTPS stellen.

### Alternative: ohne Server per GitHub Actions

In [`.github/workflows/publish.yml`](.github/workflows/publish.yml) die `schedule`-Zeilen
einkommentieren und unter *Settings → Secrets and variables → Actions* anlegen:

| Secrets | Variables (optional) |
|---|---|
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` | `IMAP_FOLDER`, `IMAP_PROCESSED_FOLDER`, `IMAP_PORT` |
| `WP_URL`, `WP_USER`, `WP_APP_PASSWORD` | `WP_STATUS`, `WP_CATEGORIES`, `SEO_PLUGIN`, `FEATURED_IMAGE` |
| `ANTHROPIC_API_KEY` | `DAILY_LIMIT`, `POSTS_PER_RUN`, `CLAUDE_MODEL`, `SITE_NAME`, `SITE_TONE` |

Einmaliger Lauf ohne Dashboard geht auch lokal: `bun run once` (bzw. `bun run once --dry-run`).

## Projektstruktur

```
server/      Bun-Backend: config, mail (IMAP), rewrite (Claude), wordpress, pipeline, db, index (API + Zeitplan), cli, demo
web/         Vue-3-Dashboard (Vite)
tests/       bun test
wordpress/   MU-Plugin für die SEO-Felder
```

## Hinweise

- Pressefotos werden mit dem Fotocredit aus der Mail als Bildunterschrift gesetzt; prüfe bei
  Bedarf die Nutzungsbedingungen der Agentur.
- E-Mail-Inhalte gelten als nicht vertrauenswürdig: Claude ignoriert Anweisungen in Mails,
  und das erzeugte HTML wird vor dem Veröffentlichen auf eine Tag-Whitelist bereinigt.
- Lehnt Claude eine Anfrage ab, springt automatisch ein Fallback-Modell ein.
- Kosten: ein Claude-Aufruf pro Mail, die den Vorfilter passiert (Entwürfe werden nicht
  doppelt generiert).

## Tests

```bash
bun test
bun run typecheck
```
