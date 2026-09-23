"""Explicit loopback-only integration server; python -m backend never uses stubs."""

import argparse
import os
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi import Body, FastAPI, HTTPException

from .ml_stub import Scenario, StubML


def create_app(adapter=None):
    from backend.app import main, ml, telegram, storage
    from .telegram_stub import FakeBotAPI
    adapter = adapter or StubML()
    bot_api = FakeBotAPI()
    bot = telegram.TelegramService(telegram.Config(True, "synthetic-token", True), bot_api)
    # Explicit ticks make test runs deterministic. No external API, worker thread or real token.
    bot.start = bot.connect

    @asynccontextmanager
    async def lifespan(app):
        with patch.object(ml, "probe", adapter.probe), patch.object(ml, "process_audio", adapter.process_audio), patch.object(ml, "process_text", adapter.process_text), patch.object(telegram, "TelegramService", return_value=bot):
            async with main.lifespan(app):
                with storage.connection() as db:
                    offset = db.execute("SELECT value FROM telegram_meta WHERE key = 'offset'").fetchone()
                bot_api.next_update = int(offset["value"]) if offset else 1
                yield

    app = FastAPI(title="TEST ONLY — synthetic ML", lifespan=lifespan)

    @app.get("/__test__/telegram")
    def telegram_state():
        return bot_api.state()

    @app.post("/__test__/telegram/update")
    def telegram_update(value: dict = Body(...)):
        bot_api.push(value)
        bot.cycle()
        return bot_api.state()

    @app.post("/__test__/telegram/tick")
    def telegram_tick():
        bot.cycle()
        return bot_api.state()

    @app.get("/__test__/state")
    def state():
        return adapter.state()

    @app.post("/__test__/scenario")
    def scenario(value: Scenario):
        try:
            return adapter.configure(value)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/__test__/release")
    def release():
        adapter.release()
        return {"released": True}

    app.mount("/", main.app)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--scenario", choices=["review", "unavailable"], default="unavailable")
    args = parser.parse_args()
    data_dir = args.data_dir.resolve()
    marker = data_dir / ".synthetic-ml-test-data"
    if (data_dir / "meetings.sqlite3").exists() and not marker.is_file():
        parser.error("Refusing an existing non-test database; choose a separate empty data directory")
    data_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text("Synthetic ML test storage, never production data.\n", encoding="utf-8")
    os.environ["DATA_DIR"] = str(data_dir)
    import uvicorn
    uvicorn.run(create_app(StubML(Scenario(name=args.scenario))), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
