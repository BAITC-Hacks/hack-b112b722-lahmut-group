"""Additive Telegram storage; meeting/ML contract and approved snapshots stay unchanged."""

import json


def initialize(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS telegram_invites (
            token_hash TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, participant_id TEXT NOT NULL,
            expires_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telegram_bindings (
            meeting_id TEXT NOT NULL, participant_id TEXT NOT NULL, binding_id TEXT NOT NULL,
            user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (meeting_id, participant_id)
        );
        CREATE TABLE IF NOT EXISTS telegram_actions (
            action_id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            version INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, last_status TEXT NOT NULL DEFAULT 'open'
        );
        CREATE TABLE IF NOT EXISTS telegram_deliveries (
            id TEXT PRIMARY KEY, action_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
            meeting_id TEXT NOT NULL, participant_id TEXT NOT NULL, binding_id TEXT NOT NULL,
            chat_id INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0, message_id INTEGER, error TEXT,
            UNIQUE(action_id, version, kind)
        );
        CREATE TABLE IF NOT EXISTS telegram_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    if "last_status" not in {row["name"] for row in db.execute("PRAGMA table_info(telegram_actions)")}:
        db.execute("ALTER TABLE telegram_actions ADD COLUMN last_status TEXT NOT NULL DEFAULT 'open'")


def participant_for(meeting, action):
    """Free-text assignee resolves only to one exact normalized saved name."""
    normalize = lambda value: " ".join(value.split()).casefold()
    name = normalize(action["assignee"])
    matches = [p for p in meeting["participants"] if name and normalize(p["display_name"]) == name]
    return matches[0]["id"] if len(matches) == 1 else None


def observe(db, meeting):
    """Called in every meeting write transaction, including edits between worker polls."""
    previous = {row["action_id"]: row for row in db.execute(
        "SELECT * FROM telegram_actions WHERE meeting_id = ?", (meeting["id"],))}
    current = set()
    for action in meeting["actions"]:
        current.add(action["id"])
        fingerprint = json.dumps([action["title"], action["assignee"], action["due_date"],
                                  action["due_text"], participant_for(meeting, action)], ensure_ascii=False)
        old = previous.get(action["id"])
        if old is None:
            db.execute("INSERT INTO telegram_actions VALUES (?, ?, ?, 1, 1, ?)",
                       (action["id"], meeting["id"], fingerprint, action["status"]))
        else:
            changed = old["fingerprint"] != fingerprint or not old["active"] or (old["last_status"] == "done" and action["status"] == "open")
            db.execute("UPDATE telegram_actions SET fingerprint = ?, version = version + ?, active = 1, last_status = ? WHERE action_id = ?",
                       (fingerprint, int(changed), action["status"], action["id"]))
    for action_id in previous.keys() - current:
        db.execute("UPDATE telegram_actions SET active = 0 WHERE action_id = ?", (action_id,))
    participant_ids = {p["id"] for p in meeting["participants"]}
    for table in ("telegram_bindings", "telegram_invites"):
        for row in db.execute(f"SELECT participant_id FROM {table} WHERE meeting_id = ?", (meeting["id"],)).fetchall():
            if row["participant_id"] not in participant_ids:
                db.execute(f"DELETE FROM {table} WHERE meeting_id = ? AND participant_id = ?",
                           (meeting["id"], row["participant_id"]))


def new_recipient(db, meeting, participant_id):
    # Old keyboards must not complete tasks on behalf of a new binding.
    for action in meeting["actions"]:
        if participant_for(meeting, action) == participant_id:
            db.execute("UPDATE telegram_actions SET version = version + 1 WHERE action_id = ?", (action["id"],))
