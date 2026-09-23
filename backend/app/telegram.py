"""Opt-in private-chat Telegram adapter. No external calls in disabled mode."""

import hashlib
import json
import os
import re
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from . import storage, telegram_store


@dataclass
class Config:
    enabled: bool = False
    token: str = field(default="", repr=False)
    include_task_text: bool = False

    @classmethod
    def from_env(cls):
        return cls(os.getenv("TELEGRAM_ENABLED", "false").lower() == "true",
                   os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
                   os.getenv("TELEGRAM_INCLUDE_TASK_TEXT", "false").lower() == "true")


class TelegramError(Exception):
    def __init__(self, code=0, retry_after=0):
        # Never include URLs, response descriptions or original exceptions: URLs contain the token.
        self.code = code
        self.retry_after = retry_after
        super().__init__(f"Telegram API error ({code or 'network'})." if code != 409 else
                         "Telegram conflict (409): stop another poller or remove the existing webhook.")


class BotAPI:
    def __init__(self, token):
        self._token = token

    def call(self, method, **payload):
        request = Request(f"https://api.telegram.org/bot{self._token}/{method}",
                          data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=10) as response:
                result = json.load(response)
        except HTTPError as exc:
            try:
                data = json.load(exc)
            except (ValueError, OSError):
                data = {}
            raise TelegramError(exc.code, data.get("parameters", {}).get("retry_after", 0)) from None
        except (URLError, OSError, ValueError):
            raise TelegramError() from None
        if not result.get("ok"):
            raise TelegramError(result.get("error_code", 0), result.get("parameters", {}).get("retry_after", 0))
        return result["result"]


def _hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _meeting(meeting_id):
    record = storage.get_record(meeting_id)
    if record is None:
        raise HTTPException(404, "Meeting not found")
    return record["meeting"]


def _participant(meeting, participant_id):
    if not any(p["id"] == participant_id for p in meeting["participants"]):
        raise HTTPException(404, "Participant not found; save the participant first")


def kinds_for(meeting, action, now):
    kinds = ["assigned"]
    if action["due_date"]:
        today = now.astimezone(ZoneInfo(meeting["timezone"])).date()
        due = date.fromisoformat(action["due_date"])
        if due < today:
            kinds.append("overdue")
        elif due <= today + timedelta(days=3):
            kinds.append("due_soon")
    return kinds


class TelegramService:
    def __init__(self, config=None, api=None, clock=time.time):
        self.config = config or Config.from_env()
        self.api = api or BotAPI(self.config.token)
        self.clock = clock
        self.username = None
        self.error = None
        self.stop_event = threading.Event()
        self.thread = None
        self.cooldown = 0

    def connect(self):
        if not self.config.enabled:
            return
        if not self.config.token:
            self.error = "Set TELEGRAM_BOT_TOKEN in .env to enable Telegram."
            return
        me = self.api.call("getMe")
        if not me.get("is_bot") or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", me.get("username", "")):
            raise TelegramError()
        # Offsets and bindings belong to this bot, not to another token's account.
        with storage._write_lock, storage.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT value FROM telegram_meta WHERE key = 'bot_id'").fetchone()
            if old and old["value"] != str(me["id"]):
                for table in ("telegram_invites", "telegram_bindings", "telegram_deliveries", "telegram_meta"):
                    db.execute(f"DELETE FROM {table}")
                db.execute("UPDATE telegram_actions SET version = version + 1")
            db.execute("INSERT OR REPLACE INTO telegram_meta VALUES ('bot_id', ?)", (str(me["id"]),))
            db.commit()
        self.username = me["username"]
        self.error = None

    def start(self):
        if self.config.enabled:
            self.thread = threading.Thread(target=self._run, name="telegram", daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join()  # Network timeout bounds shutdown; never leave a DB writer behind.

    def _run(self):
        while not self.stop_event.is_set():
            delay = 1
            try:
                if not self.username:
                    self.connect()
                if self.username:
                    self.cycle()
                else:
                    delay = 30
            except TelegramError as exc:
                self.error = str(exc)
                delay = max(5, exc.retry_after, 60 if exc.code in (401, 409) else 0)
            except Exception:
                # An adapter fault must neither kill meeting processing nor leak a bot secret.
                self.error = "Telegram worker error; retrying. Check local storage and bot configuration."
                delay = 10
            self.stop_event.wait(delay)

    def require_ready(self):
        if not self.config.enabled or not self.username:
            raise HTTPException(503, self.error or "Telegram is disabled or still connecting")

    def status(self, meeting_id):
        meeting = _meeting(meeting_id)
        with storage.connection() as db:
            bindings = {r["participant_id"]: dict(r) for r in db.execute(
                "SELECT * FROM telegram_bindings WHERE meeting_id = ?", (meeting_id,))}
            counts = {r["state"]: r["n"] for r in db.execute(
                "SELECT state, count(*) n FROM telegram_deliveries WHERE meeting_id = ? GROUP BY state", (meeting_id,))}
        participants = [{"participant_id": p["id"], "bound": p["id"] in bindings,
                         "blocked": bool(bindings.get(p["id"], {}).get("blocked", False))} for p in meeting["participants"]]
        return {"enabled": self.config.enabled, "ready": bool(self.username), "bot_username": self.username,
                "error": self.error, "include_task_text": self.config.include_task_text, "participants": participants,
                "deliveries": counts, "unmatched_action_ids": [a["id"] for a in meeting["actions"]
                                                               if not telegram_store.participant_for(meeting, a)]}

    def invite(self, meeting_id, participant_id):
        self.require_ready()
        token = secrets.token_urlsafe(32)
        expires = self.clock() + 15 * 60
        with storage._write_lock, storage.connection() as db:
            meeting = _meeting(meeting_id)
            _participant(meeting, participant_id)
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM telegram_invites WHERE expires_at <= ? OR (meeting_id = ? AND participant_id = ?)",
                       (self.clock(), meeting_id, participant_id))
            db.execute("INSERT INTO telegram_invites VALUES (?, ?, ?, ?)", (_hash(token), meeting_id, participant_id, expires))
            db.commit()
        return {"url": f"https://t.me/{self.username}?start={token}",
                "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat()}

    def unlink(self, meeting_id, participant_id):
        with storage._write_lock, storage.connection() as db:
            meeting = _meeting(meeting_id)
            _participant(meeting, participant_id)
            db.execute("BEGIN IMMEDIATE")
            for table in ("telegram_bindings", "telegram_invites"):
                db.execute(f"DELETE FROM {table} WHERE meeting_id = ? AND participant_id = ?", (meeting_id, participant_id))
            telegram_store.new_recipient(db, meeting, participant_id)
            db.commit()
        return {"unlinked": True}

    def bind(self, token, user_id, chat_id):
        with storage._write_lock, storage.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM telegram_invites WHERE token_hash = ? AND expires_at > ?",
                             (_hash(token), self.clock())).fetchone()
            if row is None:
                return False
            meeting_row = db.execute("SELECT data FROM meetings WHERE id = ?", (row["meeting_id"],)).fetchone()
            meeting = json.loads(meeting_row["data"]) if meeting_row else None
            if not meeting or not any(p["id"] == row["participant_id"] for p in meeting["participants"]):
                return False
            db.execute("INSERT OR REPLACE INTO telegram_bindings VALUES (?, ?, ?, ?, ?, 0)",
                       (row["meeting_id"], row["participant_id"], str(uuid.uuid4()), user_id, chat_id))
            db.execute("DELETE FROM telegram_invites WHERE token_hash = ?", (_hash(token),))
            telegram_store.new_recipient(db, meeting, row["participant_id"])
            db.commit()
        return True

    def handle_update(self, update):
        callback = update.get("callback_query")
        if callback:
            result = self.complete(callback)
            self.api.call("answerCallbackQuery", callback_query_id=callback["id"], text=result, show_alert=True)
            return
        msg = update.get("message", {})
        user, chat = msg.get("from", {}), msg.get("chat", {})
        # Private chat identity is authoritative; usernames and forwarded messages are ignored.
        if (chat.get("type") != "private" or not isinstance(user.get("id"), int) or user["id"] <= 0
                or user.get("is_bot") or user["id"] != chat.get("id") or msg.get("forward_origin")):
            return
        parts = msg.get("text", "").split()
        command = parts[0].split("@")[0] if parts else ""
        if command == "/start" and len(parts) == 2:
            text = ("Telegram подключён. Утверждённые поручения и напоминания будут приходить сюда."
                    if self.bind(parts[1], user["id"], chat["id"]) else
                    "Ссылка недействительна или истекла. Попросите секретаря выдать новую ссылку.")
        elif command == "/stop":
            with storage._write_lock, storage.connection() as db:
                db.execute("UPDATE telegram_bindings SET blocked = 1 WHERE user_id = ? AND chat_id = ?", (user["id"], chat["id"]))
                db.commit()
            text = "Уведомления отключены. Для повторного подключения получите новую ссылку у секретаря."
        else:
            text = "Хаттама: откройте одноразовую ссылку от секретаря для подключения. /stop — отключить уведомления."
        self.api.call("sendMessage", chat_id=chat["id"], text=text)

    def complete(self, callback):
        callback_data = callback.get("data", "")
        if not callback_data.startswith("done:"):
            return "Неизвестная кнопка."
        with storage._write_lock:
            with storage.connection() as db:
                row = db.execute("SELECT * FROM telegram_deliveries WHERE id = ?", (callback_data[5:],)).fetchone()
                binding = db.execute("SELECT * FROM telegram_bindings WHERE binding_id = ?", (row["binding_id"],)).fetchone() if row else None
                version = db.execute("SELECT version, active FROM telegram_actions WHERE action_id = ?", (row["action_id"],)).fetchone() if row else None
            chat = callback.get("message", {}).get("chat", {})
            if (not binding or binding["blocked"] or callback.get("from", {}).get("id") != binding["user_id"]
                    or chat.get("type") != "private" or chat.get("id") != binding["chat_id"]):
                return "Это поручение другого исполнителя или привязка отключена."
            if not version or not version["active"] or version["version"] != row["version"]:
                return "Поручение изменилось. Используйте новое уведомление."
            if row["state"] != "sent" or callback.get("message", {}).get("message_id") != row["message_id"]:
                return "Используйте кнопку из исходного уведомления."

            def mutate(meeting):
                action = next((a for a in meeting["actions"] if a["id"] == row["action_id"]), None)
                if not meeting["approved"] or not action or telegram_store.participant_for(meeting, action) != binding["participant_id"]:
                    return "Поручение изменилось или ожидает утверждения."
                if action["status"] == "done":
                    return "Уже выполнено."
                action["status"] = "done"
                meeting["revision"] += 1
                return "Отмечено: выполнено."
            return storage.update(row["meeting_id"], mutate) or "Поручение не найдено."

    def enqueue(self):
        now = datetime.fromtimestamp(self.clock(), timezone.utc)
        with storage._write_lock, storage.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for record in db.execute("SELECT data FROM meetings").fetchall():
                meeting = json.loads(record["data"])
                if not meeting["approved"]:
                    continue
                for action in meeting["actions"]:
                    if action["status"] != "open":
                        continue
                    participant_id = telegram_store.participant_for(meeting, action)
                    binding = db.execute("SELECT * FROM telegram_bindings WHERE meeting_id = ? AND participant_id = ? AND blocked = 0",
                                         (meeting["id"], participant_id)).fetchone()
                    if not binding:
                        continue
                    version = db.execute("SELECT version FROM telegram_actions WHERE action_id = ?", (action["id"],)).fetchone()["version"]
                    for kind in kinds_for(meeting, action, now):
                        db.execute("""INSERT INTO telegram_deliveries
                            (id, action_id, version, kind, meeting_id, participant_id, binding_id, chat_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(action_id, version, kind) DO UPDATE SET state = 'pending'
                            WHERE telegram_deliveries.state = 'cancelled'""",
                                   (str(uuid.uuid4()), action["id"], version, kind, meeting["id"], participant_id, binding["binding_id"], binding["chat_id"]))
            db.commit()

    def deliver(self):
        if self.clock() < self.cooldown:
            return
        with storage.connection() as db:
            rows = db.execute("SELECT * FROM telegram_deliveries WHERE state = 'pending' AND next_attempt <= ? ORDER BY rowid LIMIT 100", (self.clock(),)).fetchall()
        used_chats = set()
        for row in rows:
            if self.stop_event.is_set():
                break
            if row["chat_id"] in used_chats:
                continue
            with storage._write_lock, storage.connection() as db:
                meeting = _meeting(row["meeting_id"])
                action = next((a for a in meeting["actions"] if a["id"] == row["action_id"]), None)
                binding = db.execute("SELECT * FROM telegram_bindings WHERE binding_id = ? AND blocked = 0", (row["binding_id"],)).fetchone()
                version = db.execute("SELECT * FROM telegram_actions WHERE action_id = ?", (row["action_id"],)).fetchone()
                valid = (meeting["approved"] and action and action["status"] == "open" and binding
                         and version and version["active"] and version["version"] == row["version"]
                         and telegram_store.participant_for(meeting, action) == row["participant_id"]
                         and row["kind"] in kinds_for(meeting, action, datetime.fromtimestamp(self.clock(), timezone.utc)))
                if not valid:
                    db.execute("UPDATE telegram_deliveries SET state = 'cancelled' WHERE id = ?", (row["id"],))
                    db.commit()
                    continue
            kind_text = {"assigned": "Вам назначено поручение", "due_soon": "Приближается срок поручения", "overdue": "Поручение просрочено"}[row["kind"]]
            text = f"{kind_text} №{action['id'][:8]}."
            if self.config.include_task_text:
                text += f"\n{action['title'][:1200]}\nСрок: {action['due_date'] or action['due_text'][:300] or 'не указан'}"
            else:
                text += "\nПодробности — в приложении «Хаттама» у секретаря."
            used_chats.add(row["chat_id"])
            try:
                sent = self.api.call("sendMessage", chat_id=row["chat_id"], text=text,
                                     reply_markup={"inline_keyboard": [[{"text": "Выполнено", "callback_data": f"done:{row['id']}"}]]})
                with storage.connection() as db:
                    db.execute("UPDATE telegram_deliveries SET state = 'sent', message_id = ?, error = NULL WHERE id = ?", (sent["message_id"], row["id"]))
                    db.commit()
            except TelegramError as exc:
                self.error = str(exc)
                delay = max(exc.retry_after, min(300, 2 ** min(row["attempts"] + 1, 8)))
                with storage._write_lock, storage.connection() as db:
                    db.execute("UPDATE telegram_deliveries SET state = ?, attempts = attempts + 1, next_attempt = ?, error = ? WHERE id = ?",
                               ("failed" if exc.code in (400, 403) else "pending", self.clock() + delay, str(exc), row["id"]))
                    if exc.code == 403:
                        db.execute("UPDATE telegram_bindings SET blocked = 1 WHERE binding_id = ?", (row["binding_id"],))
                    db.commit()
                if exc.code in (429, 401) or not exc.code:
                    self.cooldown = self.clock() + delay
                    break

    def cycle(self):
        if not self.config.enabled or not self.username:
            return
        with storage.connection() as db:
            saved = db.execute("SELECT value FROM telegram_meta WHERE key = 'offset'").fetchone()
        offset = int(saved["value"]) if saved else 0
        updates = self.api.call("getUpdates", offset=offset, timeout=5, allowed_updates=["message", "callback_query"])
        self.error = None
        for update in updates:
            if self.stop_event.is_set():
                return
            if update["update_id"] < offset:
                continue
            try:
                self.handle_update(update)
            except TelegramError as exc:
                # Business changes are idempotent. A failed acknowledgement must not block other users.
                self.error = str(exc)
            offset = update["update_id"] + 1
            with storage.connection() as db:
                db.execute("INSERT OR REPLACE INTO telegram_meta VALUES ('offset', ?)", (str(offset),))
                db.commit()
        self.enqueue()
        self.deliver()


service = None
router = APIRouter(prefix="/api/meetings/{meeting_id}/telegram")


def current_service():
    if service is None:
        raise HTTPException(503, "Telegram adapter is not running")
    return service


@router.get("")
def get_status(meeting_id: str):
    return current_service().status(meeting_id)


@router.post("/participants/{participant_id}/invite")
def create_invite(meeting_id: str, participant_id: str):
    return JSONResponse(current_service().invite(meeting_id, participant_id), headers={"Cache-Control": "no-store"})


@router.post("/participants/{participant_id}/unlink")
def remove_binding(meeting_id: str, participant_id: str):
    return current_service().unlink(meeting_id, participant_id)
