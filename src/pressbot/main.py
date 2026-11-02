"""Einstiegspunkt: ein Durchlauf = höchstens POSTS_PER_RUN neue Beiträge."""

from __future__ import annotations

import argparse
import logging

from .config import Settings
from .mail import DONE_FLAG, SKIPPED_FLAG, Mailbox
from .rewrite import Rewriter
from .wordpress import WordPress

log = logging.getLogger("pressbot")


def run(settings: Settings, dry_run: bool = False) -> int:
    wp = WordPress(settings.wp_url, settings.wp_user, settings.wp_app_password, settings.timezone)

    already = wp.posts_today()
    remaining = min(settings.posts_per_run, settings.daily_limit - already)
    log.info("Heute schon %d/%d Beiträge – in diesem Lauf max. %d", already, settings.daily_limit, max(remaining, 0))
    if remaining <= 0:
        return 0

    rewriter = Rewriter(settings.claude_model, settings.site_name, settings.site_tone, settings.wp_categories)
    published = 0

    with Mailbox(settings.imap_host, settings.imap_port, settings.imap_user, settings.imap_password,
                 settings.imap_folder, settings.imap_processed_folder) as box:
        mails = box.candidates(settings.max_age_days)
        log.info("%d unbearbeitete Mails gefunden", len(mails))

        for mail in mails:
            if published >= remaining:
                break
            if not mail.looks_relevant:
                log.info("Übersprungen (Vorfilter): %s", mail.subject)
                if not dry_run:
                    box.mark(mail.uid, SKIPPED_FLAG)
                continue

            article = rewriter.rewrite(mail)
            if not article.relevant:
                log.info("Nicht relevant: %s – %s", mail.subject, article.reason)
                if not dry_run:
                    box.mark(mail.uid, SKIPPED_FLAG)
                continue

            if wp.slug_exists(article.slug):
                log.info("Beitrag existiert bereits (%s) – übersprungen", article.slug)
                if not dry_run:
                    box.mark(mail.uid, DONE_FLAG)
                continue

            if dry_run:
                print(f"\n=== {article.title} ===\nSlug: {article.slug}\nKategorie: {article.category}"
                      f"\nTags: {', '.join(article.tags)}\nMeta: {article.meta_description}\n\n{article.content_html}\n")
                published += 1
                continue

            image = mail.images[0] if settings.featured_image and mail.images else None
            post = wp.create_post(article, settings.wp_status, settings.seo_plugin, image)
            box.mark(mail.uid, DONE_FLAG)
            published += 1
            log.info("Veröffentlicht: %s (%s)", article.title, post.get("link"))

    log.info("Fertig – %d Beitrag/Beiträge %s", published, "(Dry-Run)" if dry_run else "")
    return published


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Nichts veröffentlichen und keine Mails markieren, nur Ergebnis ausgeben")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(Settings.from_env(), dry_run=args.dry_run)


if __name__ == "__main__":
    main()
