/**
 * Stil-Regelwerk im Dashboard bearbeiten. Die Datei (stil/regelwerk.md) bleibt unverändert als Vorlage;
 * eine eigene Fassung liegt in der Datenbank. Ohne eigene Fassung – oder nach „Zurücksetzen“ – gilt die Vorlage.
 */

import type { Store } from "./db.ts";
import { readStyleFile } from "./rewrite.ts";

const SETTING = "regelwerk";
const MAX = 200_000;

export interface RegelwerkState {
  /** gilt gerade */
  text: string;
  /** Vorlage aus der Datei */
  template: string;
  /** eigene Fassung aktiv */
  custom: boolean;
  updatedAt: string | null;
}

export class Regelwerk {
  constructor(private store: Store, private file: string) {}

  template = () => readStyleFile(this.file);

  /** was das Sprachmodell bekommt */
  current = (): string => this.store.getSetting(SETTING) ?? this.template();

  state(): RegelwerkState {
    const own = this.store.getSetting(SETTING);
    return { text: own ?? this.template(), template: this.template(), custom: own !== null, updatedAt: this.store.getSetting(`${SETTING}_at`) };
  }

  /** speichern – gleicht der Text der Vorlage, gilt einfach wieder die Vorlage */
  save(text: string): RegelwerkState {
    const clean = text.replace(/\r\n/g, "\n");
    if (clean.length > MAX) throw new Error("Regelwerk ist zu lang (höchstens 200 000 Zeichen)");
    if (clean.trim() === this.template().trim()) return this.reset();
    this.store.setSetting(SETTING, clean);
    this.store.setSetting(`${SETTING}_at`, new Date().toISOString());
    return this.state();
  }

  /** zurück zur Vorlage */
  reset(): RegelwerkState {
    this.store.deleteSetting(SETTING);
    this.store.deleteSetting(`${SETTING}_at`);
    return this.state();
  }
}
