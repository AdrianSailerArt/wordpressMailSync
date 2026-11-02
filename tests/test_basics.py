from email.message import EmailMessage

from pressbot.mail import parse_message
from pressbot.rewrite import Article, clean_article, slugify


def _raw(subject: str, html: str, image: bytes | None = None) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = "Promo <promo@label.example>"
    msg["Date"] = "Mon, 02 Nov 2026 10:00:00 +0100"
    msg.set_content("Plaintext-Version")
    msg.add_alternative(html, subtype="html")
    if image:
        msg.add_attachment(image, maintype="image", subtype="jpeg", filename="press.jpg")
    return msg.as_bytes()


def test_parse_prefers_html_and_keeps_links():
    mail = parse_message("1", _raw("Die Band – Tour 2027",
                                   '<p>Tickets <a href="https://tix.example">hier</a></p><script>x</script>'))
    assert "https://tix.example" in mail.body
    assert "script" not in mail.body
    assert mail.looks_relevant


def test_small_images_are_ignored_large_kept():
    assert parse_message("1", _raw("Tour", "<p>x</p>", b"x" * 100)).images == []
    assert len(parse_message("1", _raw("Tour", "<p>x</p>", b"x" * 50_000)).images) == 1


def test_prefilter_rejects_unrelated():
    assert not parse_message("1", _raw("Ihre Rechnung", "<p>Betrag fällig</p>")).looks_relevant


def test_slugify():
    assert slugify("Die Ärzte: Tour 2027 – alle Termine!") == "die-aerzte-tour-2027-alle-termine"


def test_clean_article_strips_unsafe_html_and_fixes_category():
    article = Article(
        relevant=True, reason="", title=" Titel ", slug="Mein Slug", focus_keyword="x",
        meta_description="m" * 200, excerpt="", category="tourdaten", tags=["a", " ", "b"],
        content_html='<h1>X</h1><p onclick="evil()">Hi <a href="javascript:alert(1)">x</a></p><script>bad()</script>',
    )
    cleaned = clean_article(article, ["News", "Tourdaten"])
    assert "<script" not in cleaned.content_html
    assert "onclick" not in cleaned.content_html
    assert "javascript:" not in cleaned.content_html
    assert "<h1>" not in cleaned.content_html
    assert cleaned.category == "Tourdaten"
    assert cleaned.slug == "mein-slug"
    assert len(cleaned.meta_description) <= 160
    assert cleaned.tags == ["a", "b"]
