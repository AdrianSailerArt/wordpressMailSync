"""WordPress-REST-API: Tageslimit prüfen, Beitrag samt Bild, Tags und SEO-Meta anlegen."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from .mail import Attachment
from .rewrite import Article

SEO_META_KEYS = {
    "yoast": {"title": "_yoast_wpseo_title", "description": "_yoast_wpseo_metadesc",
              "keyword": "_yoast_wpseo_focuskw"},
    "rankmath": {"title": "rank_math_title", "description": "rank_math_description",
                 "keyword": "rank_math_focus_keyword"},
}


class WordPress:
    def __init__(self, url: str, user: str, app_password: str, timezone: str):
        self.api = f"{url}/wp-json/wp/v2"
        self.session = requests.Session()
        self.session.auth = (user, app_password.replace(" ", ""))
        self.session.headers["User-Agent"] = "pressbot/0.1"
        self.tz = ZoneInfo(timezone)
        self._me: int | None = None

    def _req(self, method: str, path: str, **kw) -> requests.Response:
        r = self.session.request(method, f"{self.api}/{path}", timeout=60, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"WordPress {method} {path}: {r.status_code} {r.text[:300]}")
        return r

    @property
    def me(self) -> int:
        if self._me is None:
            self._me = self._req("GET", "users/me").json()["id"]
        return self._me

    def posts_today(self) -> int:
        """Anzahl der heute (lokale Zeitzone) vom Bot-Benutzer angelegten Beiträge."""
        start = datetime.now(self.tz).replace(hour=0, minute=0, second=0, microsecond=0)
        r = self._req("GET", "posts", params={
            "author": self.me, "after": start.isoformat(), "per_page": 1,
            "status": "publish,future,draft,pending", "context": "edit", "_fields": "id",
        })
        return int(r.headers.get("X-WP-Total", "0"))

    def slug_exists(self, slug: str) -> bool:
        r = self._req("GET", "posts", params={"slug": slug, "status": "publish,future,draft,pending",
                                              "context": "edit", "_fields": "id"})
        return bool(r.json())

    def _term_id(self, taxonomy: str, name: str) -> int:
        found = self._req("GET", taxonomy, params={"search": name, "per_page": 20, "_fields": "id,name"}).json()
        for term in found:
            if term["name"].lower() == name.lower():
                return term["id"]
        return self._req("POST", taxonomy, json={"name": name}).json()["id"]

    def upload_image(self, image: Attachment, alt: str, caption: str) -> int:
        r = self._req("POST", "media", data=image.data, headers={
            "Content-Type": image.content_type,
            "Content-Disposition": f'attachment; filename="{image.filename}"',
        })
        media_id = r.json()["id"]
        self._req("POST", f"media/{media_id}", json={"alt_text": alt, "caption": caption})
        return media_id

    def create_post(self, article: Article, status: str, seo_plugin: str,
                    image: Attachment | None = None) -> dict:
        payload: dict = {
            "title": article.title,
            "slug": article.slug,
            "content": article.content_html,
            "excerpt": article.excerpt,
            "status": status,
            "categories": [self._term_id("categories", article.category)],
            "tags": [self._term_id("tags", t) for t in article.tags],
        }
        keys = SEO_META_KEYS.get(seo_plugin)
        if keys:
            payload["meta"] = {
                keys["title"]: article.title,
                keys["description"]: article.meta_description,
                keys["keyword"]: article.focus_keyword,
            }
        if image is not None:
            caption = f"Foto: {article.image_credit}" if article.image_credit else ""
            payload["featured_media"] = self.upload_image(image, alt=article.title, caption=caption)
        return self._req("POST", "posts", json=payload).json()
