# pressbot 🎸

Liest dein IMAP-Postfach nach Pressemitteilungen zu Musik (Tourdaten, Konzerte, Festivals,
Releases), lässt sie von Claude als eigenständigen, SEO-optimierten Beitrag umschreiben und
veröffentlicht sie über die WordPress-REST-API – **maximal 3 Beiträge pro Tag**.

## So funktioniert's

```
IMAP-Postfach ──► Vorfilter (Keywords) ──► Claude: relevant? + Umschreiben ──► WordPress
      ▲                                                                        │
      └──────── Mail wird per IMAP-Keyword als erledigt/übersprungen markiert ◄─┘
```

1. **Tageslimit prüfen** – zählt die heute vom Bot-Benutzer angelegten Beiträge in WordPress.
   Ist `DAILY_LIMIT` erreicht, passiert nichts.
2. **Mails holen** – alle Mails der letzten `MAX_AGE_DAYS` Tage, die noch nicht bearbeitet
   wurden (neueste zuerst). Der Gelesen-Status bleibt unverändert.
3. **Vorfilter** – Mails ohne Musik-Stichworte (Tour, Konzert, Album, Release …) werden
   ohne KI-Aufruf übersprungen.
4. **Claude** entscheidet, ob es eine verwertbare Pressemitteilung ist, und schreibt sie neu:
   eigener Text, Fakten (Daten, Städte, Venues, Tickets) exakt übernommen, Fokus-Keyword,
   SEO-Titel (≤ 60 Zeichen), Meta-Description, Slug, Zwischenüberschriften, Tourdaten als
   Liste, Kategorie und Tags.
5. **WordPress** – Beitrag mit Kategorie, Tags, Auszug, SEO-Meta (Yoast oder Rank Math) und
   dem größten Bild-Anhang als Beitragsbild anlegen und veröffentlichen.
6. **Markieren** – die Mail bekommt das IMAP-Keyword `$PressbotDone` bzw. `$PressbotSkipped`
   (optional zusätzlich in `IMAP_PROCESSED_FOLDER` verschoben) und wird nie doppelt verarbeitet.

Pro Lauf erscheint standardmäßig **ein** Beitrag (`POSTS_PER_RUN=1`). Drei Läufe am Tag
(GitHub Actions, s. u.) ergeben drei über den Tag verteilte Beiträge.

## Einrichtung

### 1. WordPress vorbereiten

- Eigenen Benutzer anlegen, z. B. `pressbot` mit der Rolle **Autor** (das Tageslimit zählt
  die Beiträge dieses Benutzers).
- Als dieser Benutzer: *Profil → Anwendungspasswörter* → neues Passwort erzeugen.
- Für SEO-Felder: [`wordpress/pressbot-seo-meta.php`](wordpress/pressbot-seo-meta.php)
  nach `wp-content/mu-plugins/` kopieren und `SEO_PLUGIN=yoast` oder `rankmath` setzen.

### 2. Lokal testen

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cp .env.example .env      # Werte eintragen
.venv/bin/pressbot --dry-run
```

`--dry-run` zeigt den generierten Beitrag an, veröffentlicht nichts und markiert keine Mails.
Für die ersten echten Läufe empfiehlt sich `WP_STATUS=draft`, um die Texte zu prüfen.

### 3. Automatisch per GitHub Actions

Der Workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml) läuft um
07:00, 12:00 und 17:00 UTC. Unter *Settings → Secrets and variables → Actions* anlegen:

| Secrets | Variables (optional) |
|---|---|
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` | `IMAP_FOLDER`, `IMAP_PROCESSED_FOLDER`, `IMAP_PORT` |
| `WP_URL`, `WP_USER`, `WP_APP_PASSWORD` | `WP_STATUS`, `WP_CATEGORIES`, `SEO_PLUGIN`, `FEATURED_IMAGE` |
| `ANTHROPIC_API_KEY` | `DAILY_LIMIT`, `POSTS_PER_RUN`, `CLAUDE_MODEL`, `SITE_NAME`, `SITE_TONE` |

Manuell starten: *Actions → Pressemitteilungen veröffentlichen → Run workflow*
(standardmäßig als Dry-Run).

Alternativ geht auch ein Cronjob auf deinem Server:

```cron
0 8,13,18 * * * cd /pfad/zu/pressbot && .venv/bin/pressbot >> pressbot.log 2>&1
```

## Konfiguration

Alle Optionen mit Beschreibung stehen in [`.env.example`](.env.example).

## Hinweise

- Pressemitteilungen sind zur Veröffentlichung gedacht – Pressefotos aber oft nur mit
  Credit. Der Fotocredit aus der Mail wird als Bildunterschrift gesetzt; prüfe bei Bedarf
  die Bedingungen der Agentur.
- E-Mail-Inhalte gelten als nicht vertrauenswürdig: Claude ist angewiesen, Anweisungen in
  Mails zu ignorieren, und das erzeugte HTML wird vor dem Veröffentlichen auf eine
  Tag-Whitelist bereinigt.
- Kosten: ein Claude-Aufruf pro Mail, die den Vorfilter passiert.

## Tests

```bash
.venv/bin/pytest
```
