"""In-memory Bot API double. Never opens sockets or reads a real bot token."""

import copy
import threading

from backend.app.telegram import TelegramError


class FakeBotAPI:
    def __init__(self):
        self.calls = []
        self.updates = []
        self.failures = []
        self.lock = threading.Lock()
        self.next_message = 1
        self.next_update = 1

    def push(self, update):
        with self.lock:
            update = copy.deepcopy(update)
            update["update_id"] = self.next_update
            self.next_update += 1
            self.updates.append(update)
            return update

    def call(self, method, **payload):
        with self.lock:
            self.calls.append({"method": method, **copy.deepcopy(payload)})
            for index, failure in enumerate(self.failures):
                if failure["method"] == method:
                    self.failures.pop(index)
                    raise TelegramError(failure["code"], failure.get("retry_after", 0))
            if method == "getMe":
                return {"id": 700000001, "is_bot": True, "username": "Khattama_Test_Bot"}
            if method == "getUpdates":
                return copy.deepcopy([u for u in self.updates if u["update_id"] >= payload.get("offset", 0)])
            if method == "sendMessage":
                result = {"message_id": self.next_message}
                self.calls[-1]["message_id"] = self.next_message
                self.next_message += 1
                return result
            if method == "answerCallbackQuery":
                return True
            raise AssertionError(f"Unexpected Bot API method: {method}")

    def state(self):
        with self.lock:
            return {"test_mode": True, "calls": copy.deepcopy(self.calls)}
