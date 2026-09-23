"""Real API/SQLite with fake Telegram transport. No messages leave this process."""

import copy
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from io import BytesIO
from unittest.mock import Mock

import pytest

from backend.app import storage, telegram
from backend.testing.telegram_stub import FakeBotAPI
from backend.tests.test_backend import approved, demo


@pytest.fixture
def bot(client, monkeypatch):
    api = FakeBotAPI()
    clock = [datetime(2026, 9, 23, tzinfo=timezone.utc).timestamp()]
    service = telegram.TelegramService(telegram.Config(True, "test-token", True), api, lambda: clock[0])
    service.connect()
    service.test_clock = clock
    monkeypatch.setattr(telegram, "service", service)
    return service


def meeting(client, due="2026-09-25", approve=False):
    m = demo(client)
    actions = [m["actions"][0]]
    actions[0].update(due_date=due, review_reasons=[])
    m = client.patch(f"/api/meetings/{m['id']}", json={"revision": m["revision"], "actions": actions}).json()
    return approved(client, m) if approve else m


def invite(client, m, participant=None):
    participant = participant or m["participants"][1]["id"]
    response = client.post(f"/api/meetings/{m['id']}/telegram/participants/{participant}/invite")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()["url"].split("start=")[1]


def start_message(token, user_id=8123456789, chat_type="private"):
    return {"message": {"from": {"id": user_id, "is_bot": False}, "chat": {"id": user_id, "type": chat_type}, "text": "/start " + token}}


def bind(client, bot, m, user_id=8123456789):
    token = invite(client, m)
    bot.api.push(start_message(token, user_id))
    bot.cycle()


def messages(bot):
    return [c for c in bot.api.calls if c["method"] == "sendMessage" and "reply_markup" in c and "message_id" in c]


def callback(message, user_id=8123456789, chat_id=None):
    return {"id": "query-1", "from": {"id": user_id}, "data": message["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            "message": {"message_id": message["message_id"], "chat": {"id": user_id if chat_id is None else chat_id, "type": "private"}}}


def test_disabled_makes_no_network_calls(client, monkeypatch):
    network = Mock(side_effect=AssertionError("No network allowed"))
    monkeypatch.setattr(telegram, "urlopen", network)
    disabled = telegram.TelegramService(telegram.Config(False, "even-with-a-token"))
    disabled.start()
    disabled.connect()
    disabled.cycle()
    disabled.stop()
    m = demo(client)
    status = client.get(f"/api/meetings/{m['id']}/telegram").json()
    assert status["enabled"] is False
    assert client.post(f"/api/meetings/{m['id']}/telegram/participants/{m['participants'][0]['id']}/invite").status_code == 503
    network.assert_not_called()


def test_invite_is_private_single_use_hashed_expiring_and_revocable(client, bot):
    m = meeting(client)
    old = invite(client, m)
    token = invite(client, m)
    assert len(token) <= 64 and old != token
    assert not bot.bind(old, 1, 1)
    with storage.connection() as db:
        encoded = str([dict(r) for r in db.execute("SELECT * FROM telegram_invites")])
    assert token not in encoded
    bot.handle_update(start_message(token, chat_type="group"))
    assert not bot.status(m["id"])["participants"][1]["bound"]
    assert bot.bind(token, 8123456789, 8123456789)
    assert not bot.bind(token, 2, 2)
    assert bot.status(m["id"])["participants"][1]["bound"]
    token = invite(client, m)
    bot.test_clock[0] += 901
    assert not bot.bind(token, 2, 2)
    token = invite(client, m)
    bot.unlink(m["id"], m["participants"][1]["id"])
    assert not bot.bind(token, 2, 2)
    assert not bot.status(m["id"])["participants"][1]["bound"]


def test_invite_race_has_one_winner(client, bot):
    m = meeting(client)
    token = invite(client, m)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda user: bot.bind(token, user, user), [11, 12]))
    assert sorted(results) == [False, True]


@pytest.mark.parametrize("alter", ["forward", "bot", "chat_mismatch"])
def test_start_rejects_untrusted_context(client, bot, alter):
    m = meeting(client)
    message = start_message(invite(client, m))
    if alter == "forward":
        message["message"]["forward_origin"] = {"type": "user"}
    elif alter == "bot":
        message["message"]["from"]["is_bot"] = True
    else:
        message["message"]["chat"]["id"] = 99
    bot.handle_update(message)
    assert not bot.status(m["id"])["participants"][1]["bound"]


def test_approval_assignment_reminders_timezone_and_restart_dedup(client, bot):
    m = meeting(client)
    bind(client, bot, m)
    assert not messages(bot)
    m = approved(client, m)
    bot.cycle()
    bot.cycle()
    sent = messages(bot)
    assert len(sent) == 2 and "назначено" in sent[0]["text"] and "Приближается" in sent[1]["text"]
    assert "Подготовить план" in sent[0]["text"]
    restarted = telegram.TelegramService(bot.config, bot.api, bot.clock)
    storage.initialize()
    restarted.connect()
    restarted.cycle()
    assert len(messages(bot)) == 2
    bot.test_clock[0] = datetime(2026, 9, 25, 19, tzinfo=timezone.utc).timestamp()  # Sep 26 in Almaty
    bot.cycle()
    bot.cycle()
    assert len(messages(bot)) == 3 and "просрочено" in messages(bot)[-1]["text"]
    assert len([c for c in bot.api.calls if c["method"] == "sendMessage" and "подключён" in c["text"]]) == 1


def test_completion_checks_identity_and_keeps_approved_snapshot(client, bot):
    m = meeting(client, approve=True)
    before = storage.get_record(m["id"])["approved_meeting"]
    bind(client, bot, m)
    message = messages(bot)[0]
    assert "другого" in bot.complete(callback(message, user_id=999, chat_id=8123456789))
    wrong_chat = callback(message, chat_id=999)
    assert "другого" in bot.complete(wrong_chat)
    forged = callback(message)
    forged["message"]["message_id"] += 100
    assert "исходного" in bot.complete(forged)
    bot.api.push({"callback_query": callback(message)})
    bot.cycle()
    record = storage.get_record(m["id"])
    assert record["meeting"]["actions"][0]["status"] == "done"
    assert record["meeting"]["approved"] is True
    assert record["meeting"]["revision"] == m["revision"] + 1
    assert record["approved_meeting"] == before
    assert "Уже" in bot.complete(callback(message))
    assert storage.get_record(m["id"])["meeting"]["revision"] == m["revision"] + 1
    assert any(c["method"] == "answerCallbackQuery" and c["text"] == "Отмечено: выполнено." for c in bot.api.calls)
    bot.test_clock[0] += 10 * 86400
    bot.cycle()
    assert len(messages(bot)) == 1
    assert client.get(f"/api/meetings/{m['id']}/export.docx").status_code == 200


@pytest.mark.parametrize("field,value", [("due_date", "2026-10-01"), ("assignee", "Мадина"), ("title", "Другое поручение")])
def test_old_button_rejected_after_edit_even_if_content_returns_between_polls(client, bot, field, value):
    m = meeting(client, approve=True)
    bind(client, bot, m)
    msg = messages(bot)[0]
    old_actions = copy.deepcopy(m["actions"])
    edited = copy.deepcopy(old_actions)
    edited[0][field] = value
    m = client.patch(f"/api/meetings/{m['id']}", json={"revision": m["revision"], "actions": edited}).json()
    m = client.patch(f"/api/meetings/{m['id']}", json={"revision": m["revision"], "actions": old_actions}).json()
    approved(client, m)
    assert "изменилось" in bot.complete(callback(msg))
    bot.cycle()
    assert len(messages(bot)) == 2


def test_reapproval_resumes_unsent_cancelled_notifications(client, bot):
    m = meeting(client, approve=True)
    bind(client, bot, m)
    msg = messages(bot)[0]
    m = client.patch(f"/api/meetings/{m['id']}", json={"revision": m["revision"], "summary": "Новый итог"}).json()
    assert "утверждения" in bot.complete(callback(msg))
    bot.cycle()
    assert len(messages(bot)) == 1
    approved(client, m)
    bot.cycle()
    assert len(messages(bot)) == 2  # Due-soon was pending when approval was reset.


@pytest.mark.parametrize("code", [0, 429, 403, 400])
def test_delivery_failures_do_not_rollback_approval_and_retry_is_bounded(client, bot, code):
    m = meeting(client)
    bind(client, bot, m)
    bot.api.failures.append({"method": "sendMessage", "code": code, "retry_after": 60})
    m = approved(client, m)
    bot.cycle()
    assert storage.get_record(m["id"])["meeting"]["approved"] is True
    assert client.get(f"/api/meetings/{m['id']}/export.docx").status_code == 200
    if code in (0, 429):
        bot.cycle()
        assert not messages(bot)
        bot.test_clock[0] += 61
        bot.cycle()
        assert len(messages(bot)) == 1
    else:
        assert bot.status(m["id"])["deliveries"]["failed"] == 1
        if code == 403:
            assert bot.status(m["id"])["participants"][1]["blocked"]


def test_no_deadline_only_assignment_and_default_text_is_neutral(client, bot):
    m = meeting(client, due=None, approve=True)
    bot.config.include_task_text = False
    bind(client, bot, m)
    bot.cycle()
    bot.test_clock[0] += 365 * 86400
    bot.cycle()
    assert len(messages(bot)) == 1
    assert m["actions"][0]["title"] not in messages(bot)[0]["text"]
    assert m["title"] not in messages(bot)[0]["text"]


def test_duplicate_or_unknown_names_never_guess_recipient(client, bot):
    m = meeting(client)
    participants = copy.deepcopy(m["participants"])
    participants[0]["display_name"] = participants[1]["display_name"]
    m = client.patch(f"/api/meetings/{m['id']}", json={"revision": m["revision"], "participants": participants}).json()
    approved(client, m)
    bind(client, bot, m)
    assert not messages(bot)
    assert bot.status(m["id"])["unmatched_action_ids"] == [m["actions"][0]["id"]]


def test_removed_participant_and_rebinding_revoke_old_capabilities(client, bot):
    m = meeting(client, approve=True)
    bind(client, bot, m)
    old = messages(bot)[0]
    token = invite(client, m)
    assert bot.bind(token, 99, 99)
    assert "другого" in bot.complete(callback(old))
    bot.cycle()
    assert messages(bot)[-1]["chat_id"] == 99
    token = invite(client, m)
    m = client.patch(f"/api/meetings/{m['id']}", json={"revision": m["revision"], "participants": []}).json()
    assert not bot.bind(token, 100, 100)
    assert not bot.status(m["id"])["participants"]
    with storage.connection() as db:
        assert db.execute("SELECT count(*) FROM telegram_bindings").fetchone()[0] == 0


def test_stop_unsubscribes_and_reconnect_restores(client, bot):
    m = meeting(client, approve=True)
    bind(client, bot, m)
    old = messages(bot)[0]
    update = start_message("")
    update["message"]["text"] = "/stop"
    bot.handle_update(update)
    bot.cycle()
    assert "другого" in bot.complete(callback(old))
    assert len(messages(bot)) == 1
    bind(client, bot, m)
    assert len(messages(bot)) == 2


def test_reopened_action_cannot_be_completed_by_replayed_old_callback(client, bot):
    m = meeting(client, approve=True)
    bind(client, bot, m)
    old = messages(bot)[0]
    assert "Отмечено" in bot.complete(callback(old))
    assert client.patch(f"/api/actions/{m['actions'][0]['id']}", json={"status": "open"}).status_code == 200
    assert "изменилось" in bot.complete(callback(old))
    bot.cycle()
    assert len(messages(bot)) == 2
    assert "Отмечено" in bot.complete(callback(messages(bot)[-1]))


def test_worker_processes_updates_and_stops_cleanly(client, bot):
    m = meeting(client, approve=True)
    token = invite(client, m)
    bot.api.push(start_message(token))
    bot.start()
    try:
        deadline = time.monotonic() + 3
        while not messages(bot) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert messages(bot)
    finally:
        bot.stop()
    assert not bot.thread.is_alive()


def test_network_errors_never_expose_token(monkeypatch):
    token = "123456:super-secret-value"
    transport = telegram.BotAPI(token)
    for error in (URLError(f"https://api.telegram.org/bot{token}/getMe"),
                  HTTPError(f"https://api.telegram.org/bot{token}/getMe", 429, token, {},
                            BytesIO(json.dumps({"description": token, "parameters": {"retry_after": 17}}).encode()))):
        monkeypatch.setattr(telegram, "urlopen", Mock(side_effect=error))
        with pytest.raises(telegram.TelegramError) as exc:
            transport.call("getMe")
        assert token not in str(exc.value)
        if exc.value.code == 429:
            assert exc.value.retry_after == 17
    assert token not in repr(telegram.Config(True, token))


def test_http_transport_uses_official_post_api_and_json(monkeypatch):
    response = BytesIO(b'{"ok":true,"result":{"message_id":42}}')
    send = Mock(return_value=response)
    monkeypatch.setattr(telegram, "urlopen", send)
    result = telegram.BotAPI("test-token").call("sendMessage", chat_id=8123456789, text="Әлия: готово")
    request = send.call_args.args[0]
    assert request.full_url == "https://api.telegram.org/bottest-token/sendMessage"
    assert request.get_method() == "POST"
    assert json.loads(request.data) == {"chat_id": 8123456789, "text": "Әлия: готово"}
    assert send.call_args.kwargs["timeout"] == 10
    assert result == {"message_id": 42}


def test_missing_token_reports_configuration_error_without_network(client):
    api = Mock()
    bot = telegram.TelegramService(telegram.Config(True, ""), api)
    bot.connect()
    assert "TELEGRAM_BOT_TOKEN" in bot.error
    assert bot.username is None
    api.call.assert_not_called()


@pytest.mark.parametrize("due,kind", [("2026-09-22", "overdue"), ("2026-09-23", "due_soon"),
                                      ("2026-09-26", "due_soon"), ("2026-09-27", None)])
def test_reminder_calendar_boundaries(due, kind):
    # UTC still Sep 22, local Almaty already Sep 23.
    now = datetime(2026, 9, 22, 19, tzinfo=timezone.utc)
    assert telegram.kinds_for({"timezone": "Asia/Almaty"}, {"due_date": due}, now) == ["assigned"] + ([kind] if kind else [])


def test_bot_account_change_cannot_reuse_bindings_or_offsets(client, bot, monkeypatch):
    m = meeting(client, approve=True)
    bind(client, bot, m)
    token = invite(client, m)
    api = Mock()
    api.call.return_value = {"id": 700000002, "is_bot": True, "username": "Another_Test_Bot"}
    changed = telegram.TelegramService(bot.config, api, bot.clock)
    changed.connect()
    assert not changed.status(m["id"])["participants"][1]["bound"]
    assert not changed.bind(token, 99, 99)
    with storage.connection() as db:
        assert not db.execute("SELECT value FROM telegram_meta WHERE key = 'offset'").fetchone()
