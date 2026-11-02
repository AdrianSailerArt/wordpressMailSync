from pressbot import main
from pressbot.config import Settings
from pressbot.mail import DONE_FLAG, SKIPPED_FLAG, PressMail
from pressbot.rewrite import Article

SETTINGS = Settings(
    imap_host="h", imap_port=993, imap_user="u", imap_password="p", imap_folder="INBOX",
    imap_processed_folder="", max_age_days=7, wp_url="https://wp", wp_user="bot",
    wp_app_password="x", wp_status="publish", wp_categories=["News"], daily_limit=3, posts_per_run=1,
)

MAILS = [
    PressMail("1", "Ihre Rechnung", "a", "", "Betrag fällig"),
    PressMail("2", "Newsletter Tour", "b", "", "Nichts Konkretes"),
    PressMail("3", "Band X – Tour 2027", "c", "", "Tourdaten ..."),
    PressMail("4", "Band Y – neues Album", "d", "", "Release ..."),
]


class FakeBox:
    marks: list = []

    def __init__(self, *a): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def candidates(self, days): return MAILS
    def mark(self, uid, flag): FakeBox.marks.append((uid, flag))


class FakeWP:
    today = 0
    created: list = []

    def __init__(self, *a): pass
    def posts_today(self): return FakeWP.today
    def slug_exists(self, slug): return False
    def create_post(self, article, *a): FakeWP.created.append(article.slug); return {"link": "x"}


class FakeRewriter:
    def __init__(self, *a): pass

    def rewrite(self, mail):
        if "Newsletter" in mail.subject:
            return Article(relevant=False, reason="kein Inhalt")
        return Article(relevant=True, reason="", title=mail.subject, slug=f"post-{mail.uid}", category="News")


def _patch(monkeypatch, today):
    FakeBox.marks, FakeWP.created, FakeWP.today = [], [], today
    monkeypatch.setattr(main, "Mailbox", FakeBox)
    monkeypatch.setattr(main, "WordPress", FakeWP)
    monkeypatch.setattr(main, "Rewriter", FakeRewriter)


def test_one_post_per_run_and_marks(monkeypatch):
    _patch(monkeypatch, today=0)
    assert main.run(SETTINGS) == 1
    assert FakeWP.created == ["post-3"]
    assert FakeBox.marks == [("1", SKIPPED_FLAG), ("2", SKIPPED_FLAG), ("3", DONE_FLAG)]


def test_daily_limit_reached(monkeypatch):
    _patch(monkeypatch, today=3)
    assert main.run(SETTINGS) == 0
    assert FakeWP.created == [] and FakeBox.marks == []


def test_dry_run_changes_nothing(monkeypatch, capsys):
    _patch(monkeypatch, today=0)
    assert main.run(SETTINGS, dry_run=True) == 1
    assert FakeWP.created == [] and FakeBox.marks == []
    assert "Band X" in capsys.readouterr().out
