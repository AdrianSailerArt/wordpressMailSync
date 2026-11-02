"""Konfiguration aus Umgebungsvariablen (bzw. .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        if default is not None:
            return default
        raise SystemExit(f"Fehlende Konfiguration: {name} (siehe .env.example)")
    return value


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "ja"}


@dataclass(frozen=True)
class Settings:
    imap_host: str
    imap_port: int
    imap_user: str
    imap_password: str
    imap_folder: str
    imap_processed_folder: str
    max_age_days: int

    wp_url: str
    wp_user: str
    wp_app_password: str
    wp_status: str
    wp_categories: list[str] = field(default_factory=list)
    seo_plugin: str = "none"
    featured_image: bool = True

    daily_limit: int = 3
    posts_per_run: int = 1
    timezone: str = "Europe/Berlin"

    claude_model: str = "claude-opus-5-5"
    site_name: str = ""
    site_tone: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        return cls(
            imap_host=_env("IMAP_HOST"),
            imap_port=int(_env("IMAP_PORT", "993")),
            imap_user=_env("IMAP_USER"),
            imap_password=_env("IMAP_PASSWORD"),
            imap_folder=_env("IMAP_FOLDER", "INBOX"),
            imap_processed_folder=os.environ.get("IMAP_PROCESSED_FOLDER", "").strip(),
            max_age_days=int(_env("MAX_AGE_DAYS", "7")),
            wp_url=_env("WP_URL").rstrip("/"),
            wp_user=_env("WP_USER"),
            wp_app_password=_env("WP_APP_PASSWORD"),
            wp_status=_env("WP_STATUS", "publish"),
            wp_categories=[c.strip() for c in _env("WP_CATEGORIES", "News").split(",") if c.strip()],
            seo_plugin=_env("SEO_PLUGIN", "none").lower(),
            featured_image=_bool("FEATURED_IMAGE", True),
            daily_limit=int(_env("DAILY_LIMIT", "3")),
            posts_per_run=int(_env("POSTS_PER_RUN", "1")),
            timezone=_env("TIMEZONE", "Europe/Berlin"),
            claude_model=_env("CLAUDE_MODEL", "claude-opus-5-5"),
            site_name=_env("SITE_NAME", "Musikblog"),
            site_tone=_env("SITE_TONE", "locker und kompetent"),
        )
