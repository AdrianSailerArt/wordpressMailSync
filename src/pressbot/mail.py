"""IMAP: Kandidaten-Mails holen, parsen und als erledigt markieren."""

from __future__ import annotations

import email
import imaplib
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from email.message import EmailMessage
from email.policy import default as default_policy
from email.utils import parsedate_to_datetime

from bs4 import BeautifulSoup

DONE_FLAG = "$PressbotDone"
SKIPPED_FLAG = "$PressbotSkipped"

# Grober Vorfilter, damit nicht jede Newsletter-Mail an Claude geht.
KEYWORDS = re.compile(
    r"tour|konzert|concert|live|festival|tickets?|album|single|ep\b|release|"
    r"veröffentlich|pressemitteilung|pressemeldung|press release|presseinfo|"
    r"video|premiere|ankündig|announce|show|open\s?air",
    re.IGNORECASE,
)

MAX_BODY_CHARS = 40_000


@dataclass
class Attachment:
    filename: str
    content_type: str
    data: bytes


@dataclass
class PressMail:
    uid: str
    subject: str
    sender: str
    date: str
    body: str
    images: list[Attachment] = field(default_factory=list)

    @property
    def looks_relevant(self) -> bool:
        return bool(KEYWORDS.search(self.subject) or KEYWORDS.search(self.body[:3000]))


def html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "head"]):
        tag.decompose()
    for a in soup.find_all("a", href=True):
        if a.get_text(strip=True) and a["href"].startswith("http"):
            a.append(f" ({a['href']})")
    text = soup.get_text("\n")
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def parse_message(uid: str, raw: bytes) -> PressMail:
    msg: EmailMessage = email.message_from_bytes(raw, policy=default_policy)  # type: ignore[assignment]

    plain = msg.get_body(preferencelist=("plain",))
    html = msg.get_body(preferencelist=("html",))
    if html is not None:
        body = html_to_text(html.get_content())
    elif plain is not None:
        body = plain.get_content()
    else:
        body = ""

    images = []
    for part in msg.iter_attachments():
        ctype = part.get_content_type()
        if ctype in {"image/jpeg", "image/png", "image/webp"}:
            data = part.get_payload(decode=True) or b""
            if len(data) > 30_000:  # Logos/Tracking-Pixel überspringen
                images.append(Attachment(part.get_filename() or "bild.jpg", ctype, data))
    images.sort(key=lambda a: len(a.data), reverse=True)

    return PressMail(
        uid=uid,
        subject=str(msg.get("Subject", "")),
        sender=str(msg.get("From", "")),
        date=str(msg.get("Date", "")),
        body=body.strip()[:MAX_BODY_CHARS],
        images=images,
    )


class Mailbox:
    def __init__(self, host: str, port: int, user: str, password: str, folder: str, processed_folder: str = ""):
        self.conn = imaplib.IMAP4_SSL(host, port)
        self.conn.login(user, password)
        self.folder = folder
        self.processed_folder = processed_folder
        status, _ = self.conn.select(f'"{folder}"')
        if status != "OK":
            raise RuntimeError(f"IMAP-Ordner {folder!r} nicht gefunden")

    def __enter__(self) -> "Mailbox":
        return self

    def __exit__(self, *exc) -> None:
        try:
            self.conn.close()
        finally:
            self.conn.logout()

    def candidates(self, max_age_days: int) -> list[PressMail]:
        """Alle noch nicht bearbeiteten Mails der letzten Tage, neueste zuerst."""
        since = (date.today() - timedelta(days=max_age_days)).strftime("%d-%b-%Y")
        status, data = self.conn.uid(
            "SEARCH", None, "SINCE", since, "UNKEYWORD", DONE_FLAG, "UNKEYWORD", SKIPPED_FLAG
        )
        if status != "OK":
            raise RuntimeError(f"IMAP-Suche fehlgeschlagen: {data}")
        uids = data[0].decode().split()

        mails = []
        for uid in uids:
            # BODY.PEEK lässt den Gelesen-Status unverändert
            status, msg_data = self.conn.uid("FETCH", uid, "(BODY.PEEK[])")
            if status == "OK" and msg_data and isinstance(msg_data[0], tuple):
                mails.append(parse_message(uid, msg_data[0][1]))

        def sort_key(m: PressMail):
            try:
                return parsedate_to_datetime(m.date).timestamp()
            except (TypeError, ValueError):
                return 0.0

        return sorted(mails, key=sort_key, reverse=True)

    def mark(self, uid: str, flag: str) -> None:
        self.conn.uid("STORE", uid, "+FLAGS", f"({flag})")
        if flag == DONE_FLAG and self.processed_folder:
            status, _ = self.conn.uid("MOVE", uid, f'"{self.processed_folder}"')
            if status != "OK":
                # Server ohne MOVE-Extension: nur kopieren, Original bleibt (per Keyword markiert)
                self.conn.uid("COPY", uid, f'"{self.processed_folder}"')
