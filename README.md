# WordPress Mail Sync 🎸

Liest dein IMAP-Postfach nach Pressemitteilungen zu Musik (Tourdaten, Konzerte, Festivals,
Releases), lässt sie von einem **lokalen Sprachmodell** als eigenständigen, SEO-optimierten
Beitrag umschreiben und veröffentlicht sie über die WordPress-REST-API – **maximal 3
Beiträge pro Tag**. Läuft komplett auf deinem Mac, ohne API-Key und ohne laufende Kosten.

Mit **Vue-Dashboard**: Postfach ansehen, Beiträge vorab generieren, Titel/Meta/Text
bearbeiten, gezielt veröffentlichen oder überspringen, Verlauf aller Aktionen.

**Stack:** [Bun](https://bun.sh) + TypeScript · Hono · bun:sqlite · Vue 3 + Vite ·
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
4. **Sprachmodell** prüft die Relevanz und schreibt neu: eigener Text, Fakten exakt
   übernommen, Fokus-Keyword, SEO-Titel, Meta-Description, Slug, Zwischenüberschriften,
   Tourdaten als Liste, Kategorie und Tags (≈ 30 s pro Mail mit gemma4).
5. **WordPress** – Beitrag mit Kategorie, Tags, Auszug, SEO-Meta (Yoast/Rank Math) und dem
   größten Bild-Anhang als Beitragsbild.
6. **Markieren** – IMAP-Keyword `$PressbotDone` bzw. `$PressbotSkipped` (optional zusätzlich
   in `IMAP_PROCESSED_FOLDER` verschoben) – nichts wird doppelt verarbeitet.

Der eingebaute Zeitplan (`SCHEDULE`, Standard 8/13/18 Uhr) veröffentlicht pro Lauf einen
Beitrag → drei Beiträge über den Tag verteilt. **Der Mac muss dafür an und wach sein**;
ein verpasster Lauf wird nicht nachgeholt – dann einfach im Dashboard „Jetzt ausführen“.

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

### 3. Starten

```bash
bun install
cp .env.example .env      # IMAP- und WordPress-Zugang eintragen
bun run build             # Vue-Dashboard bauen
bun run start             # Server + Zeitplan → http://127.0.0.1:3000
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

## Anderes Modell

- Anderes lokales Modell: `OLLAMA_MODEL=…` (z. B. `gemma3:4b` – schneller, schwächer).
- Claude statt lokal: `LLM_PROVIDER=claude` und `ANTHROPIC_API_KEY` setzen.

## Projektstruktur

```
server/      Bun-Backend: config, mail (IMAP), rewrite (Ollama/Claude), wordpress, pipeline, db, index (API + Zeitplan), cli, demo
web/         Vue-3-Dashboard (Vite)
tests/       bun test
scripts/     Autostart für macOS
wordpress/   MU-Plugin für die SEO-Felder
```

## Hinweise

- Pressefotos werden mit dem Fotocredit aus der Mail als Bildunterschrift gesetzt; prüfe bei
  Bedarf die Nutzungsbedingungen der Agentur.
- E-Mail-Inhalte gelten als nicht vertrauenswürdig: Das Modell ist angewiesen, Anweisungen in
  Mails zu ignorieren, und das erzeugte HTML wird vor dem Veröffentlichen auf eine
  Tag-Whitelist bereinigt.
- Lokale Modelle sind schwächer als große Cloud-Modelle – gerade am Anfang lohnt sich ein
  Blick ins Dashboard, bevor veröffentlicht wird.
- Das Dashboard lauscht nur auf `127.0.0.1` (nur dein Mac). Wer es im Netzwerk freigibt,
  setzt `DASHBOARD_PASSWORD`.
