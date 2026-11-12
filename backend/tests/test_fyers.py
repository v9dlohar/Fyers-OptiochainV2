import asyncio
import sys
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from types import ModuleType
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import fyers
from app.config import get_settings
from app.db import Base, get_db
from app.fyers import app_id_hash
from app.main import app
from app.models import BrokerConnection, FyersFeedSettings

engine = create_engine(
    "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
)
TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def override_db() -> Generator[Session, None, None]:
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def database(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr(fyers, "_shared_market_feed", fyers._SharedMarketFeed())
    monkeypatch.setattr(fyers, "_expired_contract_catalog_cache", {})
    monkeypatch.setattr(fyers, "_option_lot_size_cache", {})
    monkeypatch.setattr(fyers, "_market_status_cache", None)
    monkeypatch.setattr(fyers, "_fyers_cooldown_until", 0.0)
    monkeypatch.setattr(fyers, "_default_chain_snapshot", None)
    monkeypatch.setattr(fyers, "_default_chain_updated_at", None)
    monkeypatch.setattr(fyers, "_default_chain_error", None)
    monkeypatch.setattr(fyers, "_feed_refresh_interval_seconds", 5)
    monkeypatch.setattr(fyers, "_option_chain_response_cache", fyers.OrderedDict())
    monkeypatch.setattr(fyers, "_expired_response_cache", fyers.OrderedDict())
    monkeypatch.setattr(fyers, "_history_response_cache", fyers.OrderedDict())
    monkeypatch.setattr(fyers, "start_fyers_feed_poller", lambda: None)
    monkeypatch.setattr(fyers, "stop_fyers_feed_poller", lambda: None)
    monkeypatch.setattr(fyers, "SessionLocal", TestingSession)
    monkeypatch.setenv("ADMIN_EMAIL", "admin@example.com")
    monkeypatch.setenv("FYERS_CLIENT_ID", "client-id")
    monkeypatch.setenv("FYERS_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("FYERS_REDIRECT_URI", "http://localhost:3000/api/fyers/callback")
    monkeypatch.setenv("FYERS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    Base.metadata.create_all(engine)
    with TestingSession() as db:
        db.add(FyersFeedSettings(id=1, refresh_interval_seconds=5))
        db.commit()
    app.dependency_overrides[get_db] = override_db
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    get_settings.cache_clear()


def _token(client: TestClient, email: str) -> str:
    client.post(
        "/auth/register",
        json={
            "email": email,
            "mobile_number": "9876543210",
            "password": "strong-password",
        },
    )
    return client.post(
        "/auth/login", json={"email": email, "password": "strong-password"}
    ).json()["access_token"]


def test_shared_market_feed_multiplexes_subscribers_and_prunes_symbols() -> None:
    import threading

    class RecordingSocket:
        def __init__(self) -> None:
            self.subscriptions: list[set[str]] = []
            self.unsubscriptions: list[set[str]] = []
            self.closed = False
            self.subscription_finished = threading.Event()
            self.unsubscription_finished = threading.Event()
            self.close_finished = threading.Event()

        def is_connected(self) -> bool:
            return not self.closed

        def subscribe(self, *, symbols: list[str], data_type: str) -> None:
            assert data_type == "SymbolUpdate"
            self.subscriptions.append(set(symbols))
            if "PUT_B" in symbols:
                self.subscription_finished.set()

        def unsubscribe(self, *, symbols: list[str], data_type: str) -> None:
            assert data_type == "SymbolUpdate"
            self.unsubscriptions.append(set(symbols))
            self.unsubscription_finished.set()

        def close_connection(self) -> None:
            self.closed = True
            self.close_finished.set()

    manager = fyers._SharedMarketFeed()
    manager.cache_option_contracts(
        "underlying",
        "expiry",
        {
            "optionsChain": [
                {"symbol": "CALL_A", "option_type": "CE"},
                {"symbol": "PUT_B", "option_type": "PE"},
            ]
        },
    )
    sockets: list[RecordingSocket] = []

    def start_stream(stream: fyers._ProviderStream, _access_token: str) -> None:
        socket = RecordingSocket()
        socket.subscriptions.append(set(stream.symbols))
        stream.socket = socket
        stream.connected = True
        sockets.append(socket)

    manager._start_stream = start_stream  # type: ignore[method-assign]
    loop = asyncio.new_event_loop()
    try:
        first_events: asyncio.Queue[dict] = asyncio.Queue()
        second_events: asyncio.Queue[dict] = asyncio.Queue()
        manager.add_subscriber(
            "first",
            loop,
            first_events,
            {"SPOT", "CALL_A"},
            "market-token",
        )
        manager.add_subscriber(
            "second",
            loop,
            second_events,
            {"SPOT", "PUT_B"},
            "market-token",
        )
        loop.run_until_complete(asyncio.sleep(0))
        assert sockets[0].subscription_finished.wait(timeout=2)

        assert len(sockets) == 1
        assert manager._streams[0].symbols == {"SPOT", "CALL_A", "PUT_B"}
        assert set().union(*sockets[0].subscriptions) == {
            "SPOT",
            "CALL_A",
            "PUT_B",
        }
        assert first_events.get_nowait() == {
            "type": "status",
            "status": "connected",
        }
        assert second_events.get_nowait() == {
            "type": "status",
            "status": "connected",
        }

        manager.remove_subscriber("first")
        assert sockets[0].unsubscription_finished.wait(timeout=2)
        assert sockets[0].unsubscriptions == [{"CALL_A"}]
        manager.remove_subscriber("second")
        assert sockets[0].close_finished.wait(timeout=2)
        assert sockets[0].closed
        assert manager._streams == []
        assert manager.cached_option_contracts("underlying", "expiry") == {
            "CALL_A",
            "PUT_B",
        }
    finally:
        loop.close()


def test_provider_subscription_does_not_hold_shared_feed_lock() -> None:
    import threading
    import time

    subscription_started = threading.Event()
    finish_subscription = threading.Event()

    class BlockingSocket:
        def is_connected(self) -> bool:
            return True

        def subscribe(self, *, symbols: list[str], data_type: str) -> None:
            assert symbols == ["NSE:NIFTY50-INDEX"]
            assert data_type == "SymbolUpdate"
            subscription_started.set()
            finish_subscription.wait(timeout=5)

    manager = fyers._SharedMarketFeed()
    stream = fyers._ProviderStream(
        socket=BlockingSocket(),
        symbols={"NSE:NIFTY50-INDEX"},
    )
    manager._streams.append(stream)

    try:
        manager._schedule_subscription(stream, set(stream.symbols))
        assert subscription_started.wait(timeout=2)
        started = time.monotonic()
        manager.cache_chain_snapshot(
            "NSE:NIFTY50-INDEX",
            "1790380800",
            {"symbol": "NSE:NIFTY50-INDEX"},
        )
        assert time.monotonic() - started < 0.5
    finally:
        finish_subscription.set()


def test_shared_market_feed_retains_last_quotes_after_subscriber_leaves() -> None:
    manager = fyers._SharedMarketFeed()
    manager._latest["SPOT"] = {
        "type": "provider",
        "message": {"symbol": "SPOT", "ltp": 123.4},
        "_cached_at": fyers.time.monotonic(),
    }
    loop = asyncio.new_event_loop()
    events: asyncio.Queue[dict] = asyncio.Queue()
    manager.add_subscriber("viewer", loop, events, {"SPOT"}, "market-token")
    manager.remove_subscriber("viewer")

    assert manager.latest_quote("SPOT") == {"symbol": "SPOT", "ltp": 123.4}
    loop.close()


def test_shared_market_feed_discards_stale_cached_quotes() -> None:
    manager = fyers._SharedMarketFeed()
    manager._latest["SPOT"] = {
        "type": "provider",
        "message": {"symbol": "SPOT", "ltp": 123.4},
        "_cached_at": fyers.time.monotonic() - 25 * 60 * 60,
    }

    assert manager.latest_quote("SPOT") is None
    assert "SPOT" not in manager._latest


def test_option_chain_falls_back_to_last_snapshot_and_live_quotes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fyers, "_fyers_option_market_status", lambda _token, _db: {"status": "OPEN"}
    )
    symbol = "NSE:NIFTY50-INDEX"
    expiry = "1790380800"
    option_symbol = "NSE:NIFTY2692625100CE"
    cached_snapshot = {
        "symbol": symbol,
        "expiries": [
            {"date": "19-09-2026", "timestamp": "1790380700", "type": "W"},
            {"date": "26-09-2026", "timestamp": expiry, "type": "W"},
        ],
        "selected_expiry": expiry,
        "spot": 25000.0,
        "spot_change": 10.0,
        "spot_change_percent": 0.04,
        "call_oi": 5000.0,
        "put_oi": 4000.0,
        "india_vix": None,
        "options": [
            {
                "symbol": option_symbol,
                "type": "CE",
                "strike": 25100.0,
                "ltp": 120.0,
                "change": 1.0,
                "change_percent": 0.8,
                "volume": 100.0,
                "oi": 1000.0,
                "oi_change": 10.0,
                "bid": 119.0,
                "ask": 121.0,
                "greeks": None,
            }
        ],
    }
    fyers._shared_market_feed.cache_chain_snapshot(symbol, expiry, cached_snapshot)
    fyers._shared_market_feed._latest[symbol] = {
        "type": "provider",
        "message": {"symbol": symbol, "ltp": 25025.0, "ch": 35.0, "chp": 0.14},
        "_cached_at": fyers.time.monotonic(),
    }
    fyers._shared_market_feed._latest[option_symbol] = {
        "type": "provider",
        "message": {
            "symbol": option_symbol,
            "ltp": 125.0,
            "vol_traded_today": 150.0,
            "OI": 1050.0,
            "bid_price": 124.0,
            "ask_price": 126.0,
        },
        "_cached_at": fyers.time.monotonic(),
    }

    monkeypatch.setattr(
        fyers,
        "_fyers_data",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            fyers.HTTPException(status_code=502, detail="Provider unavailable")
        ),
    )
    monkeypatch.setattr(
        fyers,
        "_decrypt_access_token",
        lambda _connection: "cached-snapshot-test-token",
    )

    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(
                        b"cached-snapshot-test-token"
                    ).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/option-chain",
            params={"symbol": symbol, "timestamp": expiry},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["spot"] == 25025.0
    assert payload["spot_change"] == 35.0
    assert payload["options"][0]["ltp"] == 125.0
    assert payload["options"][0]["volume"] == 150.0
    assert payload["options"][0]["oi"] == 1050.0
    assert payload["data_status"] == "stale"
    assert payload["data_error"] == "Provider unavailable"


def test_shared_market_feed_shards_union_at_provider_symbol_limit() -> None:
    class RecordingSocket:
        def subscribe(self, *, symbols: list[str], data_type: str) -> None:
            assert data_type == "SymbolUpdate"

        def close_connection(self) -> None:
            return None

    manager = fyers._SharedMarketFeed()

    def start_stream(stream: fyers._ProviderStream, _access_token: str) -> None:
        stream.socket = RecordingSocket()
        stream.connected = True

    manager._start_stream = start_stream  # type: ignore[method-assign]
    symbols = {f"SYMBOL:{index}" for index in range(201)}

    manager._add_symbols(symbols, "market-token")

    assert len(manager._streams) == 2
    assert all(len(stream.symbols) <= 200 for stream in manager._streams)
    assert set().union(*(stream.symbols for stream in manager._streams)) == symbols


def test_shared_market_feed_waits_for_socket_before_subscribing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading
    import time

    callback_started = threading.Event()
    allow_socket_open = threading.Event()
    subscribed = threading.Event()

    class DelayedSocket:
        def __init__(self, **kwargs) -> None:
            self.on_connect = kwargs["on_connect"]
            self.ready = False
            self.subscribed_symbols: list[str] = []

        def connect(self) -> None:
            self.on_connect()
            callback_started.set()
            allow_socket_open.wait(timeout=2)
            self.ready = True

        def is_connected(self) -> bool:
            return self.ready

        def subscribe(self, *, symbols: list[str], data_type: str) -> None:
            assert data_type == "SymbolUpdate"
            self.subscribed_symbols.extend(symbols)
            subscribed.set()

        def close_connection(self) -> None:
            self.ready = False

    sdk_package = ModuleType("fyers_apiv3")
    websocket_package = ModuleType("fyers_apiv3.FyersWebsocket")
    data_ws = ModuleType("fyers_apiv3.FyersWebsocket.data_ws")
    data_ws.FyersDataSocket = DelayedSocket
    websocket_package.data_ws = data_ws
    sdk_package.FyersWebsocket = websocket_package
    monkeypatch.setitem(sys.modules, "fyers_apiv3", sdk_package)
    monkeypatch.setitem(sys.modules, "fyers_apiv3.FyersWebsocket", websocket_package)
    monkeypatch.setitem(sys.modules, "fyers_apiv3.FyersWebsocket.data_ws", data_ws)

    manager = fyers._SharedMarketFeed()
    loop = asyncio.new_event_loop()
    events: asyncio.Queue[dict] = asyncio.Queue()
    try:
        manager.add_subscriber(
            "delayed",
            loop,
            events,
            {"NSE:NIFTY50-INDEX"},
            "market-token",
        )
        assert callback_started.wait(timeout=2)
        assert manager._streams[0].connected is False
        allow_socket_open.set()
        assert subscribed.wait(timeout=2)
        assert manager._streams[0].connected is True
        assert manager._streams[0].socket.subscribed_symbols == [
            "NSE:NIFTY50-INDEX"
        ]
        manager.remove_subscriber("delayed")
    finally:
        allow_socket_open.set()
        time.sleep(0.05)
        loop.close()


def test_admin_dependency_rejects_non_admin() -> None:
    with TestClient(app) as client:
        token = _token(client, "user@example.com")
        response = client.get(
            "/admin/fyers/status", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 403


def test_market_status_uses_fyers_nse_derivatives_segment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_payload = {
        "s": "ok",
        "marketStatus": [
            {
                "exchange": 10,
                "segment": 10,
                "market_type": "NORMAL",
                "status": "POSTCLOSE_CLOSED",
            },
            {
                "exchange": 10,
                "segment": 11,
                "market_type": "NORMAL",
                "status": "CLOSED",
            },
            {
                "exchange": 10,
                "segment": 20,
                "market_type": "NORMAL",
                "status": "OPEN",
            },
        ],
    }
    requests: list[tuple[str, dict[str, str]]] = []
    current_time = {
        "value": datetime(2026, 9, 25, 9, 15, tzinfo=fyers._FYERS_TIMEZONE)
    }
    monkeypatch.setattr(fyers, "_fyers_now", lambda: current_time["value"])

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return provider_payload

    def provider_get(url: str, *, headers: dict[str, str], timeout: int):
        assert timeout == 15
        requests.append((url, headers))
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    monkeypatch.setattr(
        fyers, "_decrypt_access_token", lambda _connection: "market-status-token"
    )

    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(
                        b"market-status-token"
                    ).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        with TestingSession() as db:
            assert fyers._fyers_option_market_status(
                "market-status-token", db
            )["status"] == "UNKNOWN"
        assert requests == []
        current_time["value"] = datetime(
            2026, 9, 25, 9, 16, tzinfo=fyers._FYERS_TIMEZONE
        )
        response = client.get(
            "/admin/fyers/market-status",
            headers={"Authorization": "Bearer " + token},
        )

    assert response.status_code == 200
    assert response.json() == {
        "exchange": "NSE",
        "segment": "FO",
        "market_type": "NORMAL",
        "status": "CLOSED",
    }
    assert len(requests) == 1
    assert requests[0][0].endswith("/data/marketStatus")
    assert requests[0][1]["Authorization"] == "client-id:market-status-token"
    with TestingSession() as db:
        assert fyers._fyers_option_market_status(
            "market-status-token", db
        ) == response.json()
        settings = db.get(fyers.FyersFeedSettings, 1)
        assert settings is not None
        assert settings.market_status_checked_on == current_time["value"].date()
        assert settings.market_status == "CLOSED"
    assert len(requests) == 1


def test_pending_non_admin_can_read_market_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fyers,
        "_fyers_option_market_status",
        lambda _access_token, _db: {
            "exchange": "NSE",
            "segment": "FO",
            "market_type": "NORMAL",
            "status": "CLOSED",
        },
    )
    monkeypatch.setattr(
        fyers, "_decrypt_access_token", lambda _connection: "pending-user-token"
    )
    with TestClient(app) as client:
        token = _token(client, "pending@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(
                        b"pending-user-token"
                    ).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/market-status",
            headers={"Authorization": "Bearer " + token},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "CLOSED"


def test_admin_can_change_shared_fyers_feed_interval() -> None:
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        authorization = {"Authorization": f"Bearer {token}"}
        initial = client.get("/admin/fyers/feed-settings", headers=authorization)
        updated = client.put(
            "/admin/fyers/feed-settings",
            headers=authorization,
            json={"refresh_interval_seconds": 2},
        )
        current = client.get("/admin/fyers/feed-settings", headers=authorization)

    assert initial.status_code == 200
    assert initial.json() == {"refresh_interval_seconds": 5}
    assert updated.status_code == 200
    assert updated.json() == {"refresh_interval_seconds": 2}
    assert current.json() == {"refresh_interval_seconds": 2}


def test_admin_can_view_daily_fyers_api_usage_and_daily_reset() -> None:
    today = datetime.now(fyers._FYERS_TIMEZONE).date()
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        authorization = {"Authorization": f"Bearer {token}"}
        with TestingSession() as db:
            settings = db.get(FyersFeedSettings, 1)
            assert settings is not None
            settings.api_requests_date = today
            settings.api_requests_today = 4999
            db.commit()
        fyers._record_fyers_api_request()
        usage = client.get("/admin/fyers/api-usage", headers=authorization)

        with TestingSession() as db:
            settings = db.get(FyersFeedSettings, 1)
            assert settings is not None
            settings.api_requests_date = today - timedelta(days=1)
            settings.api_requests_today = 27
            db.commit()
        reset_usage = client.get("/admin/fyers/api-usage", headers=authorization)
        member_token = _token(client, "member@example.com")
        forbidden = client.get(
            "/admin/fyers/api-usage",
            headers={"Authorization": f"Bearer {member_token}"},
        )

    assert usage.status_code == 200
    assert usage.json() == {
        "date": today.isoformat(),
        "daily_limit": 5000,
        "requests_used": 5000,
        "requests_remaining": 0,
    }
    assert reset_usage.status_code == 200
    assert reset_usage.json()["requests_used"] == 0
    assert reset_usage.json()["requests_remaining"] == 5000
    assert forbidden.status_code == 403


def test_fyers_rest_request_counter_excludes_cached_responses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fyers.httpx,
        "get",
        lambda *args, **kwargs: httpx.Response(
            200,
            json={"s": "ok", "data": {"expiryData": [], "optionsChain": []}},
            request=httpx.Request("GET", "https://api-t1.fyers.in/data/quotes"),
        ),
    )

    first = fyers._fyers_data(
        "quotes", {"symbols": "NSE:NIFTY50-INDEX"}, "access-token"
    )
    cached = fyers._fyers_data(
        "quotes", {"symbols": "NSE:NIFTY50-INDEX"}, "access-token"
    )
    with TestingSession() as db:
        settings = db.get(FyersFeedSettings, 1)

    assert first == cached == {"expiryData": [], "optionsChain": []}
    assert settings is not None
    assert settings.api_requests_today == 1


def test_shared_poller_keeps_successful_refreshes_on_interval_start_cadence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"now": 0.0}
    delays: list[float] = []

    class StopAfterOneWait:
        stopped = False

        def is_set(self) -> bool:
            return self.stopped

        def wait(self, delay: float) -> bool:
            delays.append(delay)
            self.stopped = True
            return True

    monkeypatch.setattr(fyers, "_feed_poller_stop", StopAfterOneWait())
    monkeypatch.setattr(fyers.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(fyers, "_feed_interval", lambda _db: 5)

    def refresh(_db: Session) -> str:
        clock["now"] += 1.25
        return "OPEN"

    monkeypatch.setattr(fyers, "_refresh_default_chain_once", refresh)
    fyers._fyers_feed_poller()

    assert delays == [3.75]


def test_shared_default_nifty_snapshot_ignores_faster_stream_quotes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot = {
        "selected_expiry": "20261231",
        "expiries": [{"timestamp": "20261231"}],
        "spot": 25000,
        "options": [{"symbol": "NSE:NIFTY26DEC25000CE", "ltp": 100}],
    }
    monkeypatch.setattr(
        fyers._shared_market_feed,
        "latest_quote",
        lambda symbol: {"ltp": 999} if symbol == "NSE:NIFTY50-INDEX" else {"ltp": 250},
    )

    default_snapshot = fyers._apply_option_chain_quotes(
        "NSE:NIFTY50-INDEX", snapshot
    )
    other_expiry = fyers._apply_option_chain_quotes(
        "NSE:NIFTY50-INDEX",
        {**snapshot, "selected_expiry": "20270107"},
    )

    assert default_snapshot["spot"] == 25000
    assert default_snapshot["options"][0]["ltp"] == 100
    assert other_expiry["spot"] == 999
    assert other_expiry["options"][0]["ltp"] == 250


def test_fyers_429_response_pauses_followup_provider_requests() -> None:
    response = httpx.Response(
        429,
        headers={"Retry-After": "120"},
        json={"message": "rate limit"},
        request=httpx.Request("GET", "https://api-t1.fyers.in/data/options-chain-v3"),
    )
    error = httpx.HTTPStatusError(
        "too many requests", request=response.request, response=response
    )

    with pytest.raises(fyers.HTTPException) as limited:
        fyers._raise_fyers_rate_limit(error, "option chain")
    with pytest.raises(fyers.HTTPException) as paused:
        fyers._ensure_fyers_api_available()

    assert limited.value.status_code == 503
    assert limited.value.headers == {"Retry-After": "120"}
    assert paused.value.status_code == 503
    assert int(paused.value.headers["Retry-After"]) > 0


def test_daily_rate_limit_waits_for_next_weekday_market_open() -> None:
    before_open = datetime(
        2026, 9, 25, 8, 0, tzinfo=fyers._FYERS_TIMEZONE
    )
    after_open = datetime(
        2026, 9, 25, 16, 0, tzinfo=fyers._FYERS_TIMEZONE
    )

    assert fyers._next_fyers_market_open(before_open) == datetime(
        2026, 9, 25, 9, 15, tzinfo=fyers._FYERS_TIMEZONE
    )
    assert fyers._next_fyers_market_open(after_open) == datetime(
        2026, 9, 28, 9, 15, tzinfo=fyers._FYERS_TIMEZONE
    )


def test_shared_nifty_poller_fetches_only_when_market_is_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    market_status = {"status": "CLOSED"}
    provider_calls: list[tuple[str, dict[str, str]]] = []
    chain_data = {
        "expiryData": [
            {"date": "26-09-2026", "expiry": "1790380800", "expiry_flag": "W"}
        ],
        "optionsChain": [],
    }

    monkeypatch.setattr(
        fyers,
        "_fyers_option_market_status",
        lambda _token, _db: market_status.copy(),
    )
    monkeypatch.setattr(
        fyers, "_get_access_token", lambda _connection, _db: "poller-token"
    )
    monkeypatch.setattr(
        fyers,
        "_fyers_data",
        lambda endpoint, params, _token: (
            provider_calls.append((endpoint, params.copy())) or chain_data
        ),
    )
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(b"stored-token").decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()

            assert fyers._refresh_default_chain_once(db) == "CLOSED"
            assert provider_calls == []

            market_status["status"] = "OPEN"
            assert fyers._refresh_default_chain_once(db) == "OPEN"
        response = client.get(
            "/admin/fyers/option-chain",
            params={"symbol": "NSE:NIFTY50-INDEX"},
            headers={"Authorization": f"Bearer {token}"},
        )
        market_status["status"] = "CLOSED"
        closed_response = client.get(
            "/admin/fyers/option-chain",
            params={"symbol": "NSE:NIFTY50-INDEX"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert len(provider_calls) == 1
    assert provider_calls[0] == (
        "options-chain-v3",
        {"symbol": "NSE:NIFTY50-INDEX", "strikecount": "50", "greeks": "1"},
    )
    assert fyers._default_chain_snapshot is not None
    assert fyers._default_chain_snapshot["data_status"] == "live"
    assert response.status_code == 200
    assert response.json()["data_status"] == "live"
    assert closed_response.status_code == 200
    assert closed_response.json()["data_status"] == "closed"


def test_state_is_one_time_and_tokens_are_not_disclosed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "access_token": "provider-access",
                "refresh_token": "provider-refresh",
            }

    monkeypatch.setattr(fyers.httpx, "post", lambda *args, **kwargs: ProviderResponse())
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        response = client.get(
            "/admin/fyers/login",
            headers={"Authorization": f"Bearer {token}"},
            follow_redirects=False,
        )
        assert response.status_code == 307
        location = response.headers["location"]
        query = parse_qs(urlparse(location).query)
        assert query["client_id"] == ["client-id"]
        assert query["redirect_uri"] == ["http://localhost:3000/api/fyers/callback"]
        state = query["state"][0]
        first = client.get(
            f"/admin/fyers/callback?auth_code=code&state={state}",
            follow_redirects=False,
        )
        assert first.status_code == 307
        assert "provider-access" not in first.text
        connection = TestingSession().scalar(
            select(BrokerConnection).where(BrokerConnection.provider == "fyers")
        )
        assert connection is not None
        assert "provider-access" not in connection.encrypted_access_token
        assert (
            client.get(
                f"/admin/fyers/callback?auth_code=code&state={state}"
            ).status_code
            == 400
        )


def test_callback_reports_sanitized_fyers_exchange_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = httpx.Request(
        "POST", "https://api-t1.fyers.in/api/v3/validate-authcode"
    )
    provider_response = httpx.Response(
        401,
        json={
            "code": 401,
            "message": "Invalid authorization code: authorization-code",
        },
        request=request,
    )

    def reject_exchange(*args: object, **kwargs: object) -> httpx.Response:
        raise httpx.HTTPStatusError(
            "FYERS rejected the request",
            request=request,
            response=provider_response,
        )

    monkeypatch.setattr(fyers.httpx, "post", reject_exchange)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        authorization = {"Authorization": f"Bearer {token}"}
        login = client.get(
            "/admin/fyers/login",
            headers=authorization,
            follow_redirects=False,
        )
        state = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
        callback = client.get(
            f"/admin/fyers/callback?auth_code=authorization-code&state={state}",
            follow_redirects=False,
        )

    assert callback.status_code == 502
    assert "HTTP 401" in callback.json()["detail"]
    assert "Invalid authorization code" in callback.json()["detail"]
    assert "authorization-code" not in callback.json()["detail"]


def test_app_id_hash_construction() -> None:
    assert app_id_hash("id", "secret") == (
        "fc69635ed79e43dad7499156fbf1091dcd3a721d90c7e9115786fc5a4204d669"
    )


def test_profile_uses_decrypted_token_without_disclosing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "profile-access-token"
    profile = {"code": 200, "data": {"name": "Admin", "email": "admin@example.com"}}

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {**profile, "access_token": provider_token}

    calls: dict = {}

    def provider_get(*args, **kwargs):
        calls.update(kwargs)
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()

        response = client.get(
            "/admin/fyers/profile", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 200
    assert response.json() == profile
    assert provider_token not in response.text
    assert calls["headers"]["Authorization"] == f"client-id:{provider_token}"


def test_fyers_login_can_be_verified_with_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "oauth-profile-access-token"
    profile = {
        "s": "ok",
        "code": 200,
        "data": {
            "name": "Admin",
            "email_id": "admin@example.com",
            "fy_id": "AB12345",
        },
    }

    class ProviderResponse:
        def __init__(self, payload: dict) -> None:
            self.payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return self.payload

    monkeypatch.setattr(
        fyers.httpx,
        "post",
        lambda *args, **kwargs: ProviderResponse({"access_token": provider_token}),
    )
    monkeypatch.setattr(
        fyers.httpx, "get", lambda *args, **kwargs: ProviderResponse(profile)
    )

    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        authorization = {"Authorization": f"Bearer {token}"}
        login = client.get(
            "/admin/fyers/login",
            headers=authorization,
            follow_redirects=False,
        )
        state = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
        callback = client.get(
            f"/admin/fyers/callback?auth_code=authorization-code&state={state}",
            follow_redirects=False,
        )
        assert callback.status_code == 307

        status_response = client.get("/admin/fyers/status", headers=authorization)
        profile_response = client.get("/admin/fyers/profile", headers=authorization)

    assert status_response.json()["connected"] is True
    assert profile_response.status_code == 200
    assert profile_response.json() == profile
    assert provider_token not in profile_response.text


def test_expiring_market_access_token_is_refreshed_and_rotated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FYERS_PIN", "1234")
    get_settings.cache_clear()
    old_access = jwt.encode(
        {"exp": (datetime.now(UTC) + timedelta(minutes=1)).timestamp()},
        "test-signing-key-with-at-least-thirty-two-bytes",
        algorithm="HS256",
    )
    old_refresh = "provider-refresh-token"
    new_access = "rotated-provider-access-token"
    new_refresh = "rotated-provider-refresh-token"
    calls: dict[str, object] = {}

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"access_token": new_access, "refresh_token": new_refresh}

    def refresh(*args: object, **kwargs: object) -> ProviderResponse:
        calls.update(kwargs)
        calls["url"] = args[0]
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "post", refresh)
    cipher = Fernet(get_settings().fyers_encryption_key.encode())
    with TestingSession() as db:
        connection = BrokerConnection(
            provider="fyers",
            encrypted_access_token=cipher.encrypt(old_access.encode()).decode(),
            encrypted_refresh_token=cipher.encrypt(old_refresh.encode()).decode(),
            connected_by_user_id=1,
        )
        db.add(connection)
        db.commit()

        assert fyers._get_access_token(connection, db) == new_access
        db.refresh(connection)

        assert (
            cipher.decrypt(connection.encrypted_access_token.encode()).decode()
            == new_access
        )
        assert (
            cipher.decrypt(connection.encrypted_refresh_token.encode()).decode()
            == new_refresh
        )

    assert calls["url"] == (
        "https://api-t1.fyers.in/api/v3/validate-refresh-token"
    )
    payload = calls["json"]
    assert isinstance(payload, dict)
    assert payload["grant_type"] == "refresh_token"
    assert payload["refresh_token"] == old_refresh
    assert payload["pin"] == "1234"
    assert payload["appIdHash"] == app_id_hash("client-id", "client-secret")
    assert old_refresh not in connection.encrypted_refresh_token
    get_settings.cache_clear()


def test_profile_rejects_fyers_provider_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "profile-access-token"

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"s": "error", "code": 401}

    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        monkeypatch.setattr(
            fyers.httpx, "get", lambda *args, **kwargs: ProviderResponse()
        )
        response = client.get(
            "/admin/fyers/profile", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 502
    assert response.json()["detail"] == "FYERS profile verification failed"


def test_option_chain_returns_fyers_expiries_contracts_and_greeks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fyers,
        "_fyers_option_market_status",
        lambda _token, _db: {"status": "OPEN"},
    )
    provider_token = "options-access-token"
    expiry = "1790380800"
    discovery = {
        "expiryData": [
            {"date": "26-09-2026", "expiry": expiry, "expiry_flag": "W"}
        ],
        "callOi": 125000,
        "putOi": 150000,
        "optionsChain": [],
    }
    selected_chain = {
        **discovery,
        "optionsChain": [
            {"option_type": "", "strike_price": -1, "ltp": 25120.5, "ltpch": 12.5},
            {
                "symbol": "NSE:NIFTY2692625100CE",
                "option_type": "CE",
                "strike_price": 25100,
                "ltp": 120.25,
                "volume": 1200,
                "oi": 5000,
                "oich": 250,
                "greeks": {
                    "delta": 0.52,
                    "gamma": 0.001,
                    "theta": -14.2,
                    "vega": 9.8,
                    "iv": 14.6,
                },
                "access_token": provider_token,
            },
            {
                "symbol": "NSE:NIFTY2692625100PE",
                "option_type": "PE",
                "strike_price": 25100,
                "ltp": 98.75,
                "volume": 950,
                "oi": 6200,
                "greeks": {
                    "delta": -0.48,
                    "gamma": 0.001,
                    "theta": -13.8,
                    "vega": 9.7,
                    "iv": 14.8,
                },
            },
        ],
    }

    class ProviderResponse:
        def __init__(self, data: dict) -> None:
            self.data = data

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"s": "ok", "data": self.data}

    calls: list[dict] = []

    def provider_get(*args, **kwargs):
        calls.append(kwargs)
        params = kwargs["params"]
        data = discovery if "timestamp" not in params else selected_chain
        return ProviderResponse(data)

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/option-chain",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "timestamp": expiry,
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["expiries"] == [
        {"date": "26-09-2026", "timestamp": expiry, "type": "W"}
    ]
    assert payload["spot"] == 25120.5
    assert payload["call_oi"] == 125000
    assert payload["put_oi"] == 150000
    assert payload["options"][0]["symbol"] == "NSE:NIFTY2692625100CE"
    assert payload["options"][0]["greeks"] == {
        "delta": 0.52,
        "gamma": 0.001,
        "theta": -14.2,
        "vega": 9.8,
        "iv": 14.6,
    }
    assert provider_token not in response.text
    assert calls[0]["params"] == {
        "symbol": "NSE:NIFTY50-INDEX",
        "strikecount": "1",
        "greeks": "1",
    }
    assert calls[1]["params"] == {
        "symbol": "NSE:NIFTY50-INDEX",
        "strikecount": "50",
        "timestamp": expiry,
        "greeks": "1",
    }
    assert all(
        call["headers"]["Authorization"] == f"client-id:{provider_token}"
        for call in calls
    )


@pytest.mark.parametrize(
    ("options", "detail"),
    [
        (
            [
                {
                    "symbol": "NSE:NIFTY2692625100CE",
                    "option_type": "CE",
                    "strike_price": 25150,
                }
            ],
            "does not match its reported CE strike",
        ),
        (
            [
                {
                    "symbol": "NSE:NIFTY2692625100CE",
                    "option_type": "CE",
                    "strike_price": 25100,
                },
                {
                    "symbol": "NSE:NIFTY2692625100CE",
                    "option_type": "CE",
                    "strike_price": 25100,
                },
            ],
            "more than one CE contract for strike",
        ),
        (
            [
                {"symbol": "", "option_type": "PE", "strike_price": 25100},
            ],
            "without a valid symbol and strike",
        ),
    ],
)
def test_option_chain_rejects_mismatched_or_duplicate_contracts(
    options: list[dict], detail: str
) -> None:
    with pytest.raises(fyers.HTTPException) as error:
        fyers._normalize_option_chain({"optionsChain": options})

    assert error.value.status_code == 502
    assert detail in error.value.detail


def test_option_chain_rejects_unavailable_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fyers,
        "_fyers_option_market_status",
        lambda _token, _db: {"status": "OPEN"},
    )
    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "s": "ok",
                "data": {
                    "expiryData": [
                        {
                            "date": "26-09-2026",
                            "expiry": "1790380800",
                            "expiry_flag": "W",
                        }
                    ],
                    "optionsChain": [],
                },
            }

    calls = 0

    def provider_get(*args, **kwargs):
        nonlocal calls
        calls += 1
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(b"options-access-token").decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/option-chain",
            params={"symbol": "NSE:NIFTY50-INDEX", "timestamp": "1790467200"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Invalid expiry for FYERS symbol"
    assert calls == 1


def test_history_returns_normalized_spot_candles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "history-access-token"
    provider_payload = {
        "s": "ok",
        "candles": [
            [1790421000, 25100, 25130, 25090, 25120, 1200],
            [1790421300, 25120, 25140, 25110, 25135, 1500],
            [1790421300, 25120, 25145, 25110, 25138, 1600],
            [1790421600, 25135, 25120, 25130, 25110, 900],
            ["invalid", 25100, 25130, 25090, 25120, 1200],
        ],
    }

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return provider_payload

    calls: list[dict] = []

    def provider_get(*args, **kwargs):
        calls.append(kwargs)
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(
                        provider_token.encode()
                    ).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()

        response = client.get(
            "/admin/fyers/history",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "resolution": "2",
                "range_from": "2025-03-26",
                "range_to": "2025-03-27",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        repeated = client.get(
            "/admin/fyers/history",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "resolution": "2",
                "range_from": "2025-03-26",
                "range_to": "2025-03-27",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert repeated.json() == response.json()
    assert response.json() == {
        "symbol": "NSE:NIFTY50-INDEX",
        "resolution": "2",
        "candles": [
            {
                "time": 1790421000,
                "open": 25100,
                "high": 25130,
                "low": 25090,
                "close": 25120,
                "volume": 1200,
            },
            {
                "time": 1790421300,
                "open": 25120,
                "high": 25145,
                "low": 25110,
                "close": 25138,
                "volume": 1600,
            },
        ],
    }
    assert calls[0]["params"]["symbol"] == "NSE:NIFTY50-INDEX"
    assert calls[0]["params"]["resolution"] == "2"
    assert calls[0]["params"]["range_from"] == "2025-03-26"
    assert calls[0]["params"]["range_to"] == "2025-03-27"
    assert calls[0]["params"]["date_format"] == "1"
    assert calls[0]["params"]["cont_flag"] == "1"
    assert calls[0]["headers"]["Authorization"] == f"client-id:{provider_token}"
    assert len(calls) == 1
    assert provider_token not in response.text


def test_history_rejects_invalid_symbol_and_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def provider_get(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("Invalid history query must not call the provider")

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        headers = {"Authorization": f"Bearer {token}"}
        bad_symbol = client.get(
            "/admin/fyers/history",
            params={"symbol": "NSE:UNKNOWN-INDEX", "resolution": "5"},
            headers=headers,
        )
        bad_resolution = client.get(
            "/admin/fyers/history",
            params={"symbol": "NSE:NIFTY50-INDEX", "resolution": "7"},
            headers=headers,
        )

    assert bad_symbol.status_code == 422
    assert bad_resolution.status_code == 422
    assert calls == 0


def test_expired_expiry_dates_return_option_and_future_dates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "expired-expiry-access"

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "s": "ok",
                "data": {
                    "symbol": "NSE:NIFTY50-INDEX",
                    "expiry_dates": {
                        "futures": ["2025-03-27", {"date": "2025-04-24"}],
                        "options": ["2025-03-27", "28-03-2025", "invalid", 123],
                    },
                },
            }

    calls: list[dict] = []

    def provider_get(*args, **kwargs):
        calls.append(kwargs)
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/expired/expiry-dates",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "range_from": "2025-01-01",
                "range_to": "2025-12-31",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "symbol": "NSE:NIFTY50-INDEX",
        "futures": ["2025-03-27", "2025-04-24"],
        "options": ["2025-03-27", "2025-03-28"],
    }
    assert calls[0]["params"] == {
        "symbol": "NSE:NIFTY50-INDEX",
        "range_from": "2025-01-01",
        "range_to": "2025-12-31",
        "date_format": "1",
    }
    assert calls[0]["headers"]["Authorization"] == f"client-id:{provider_token}"


def test_expired_expiry_dates_retry_invalid_ranges_by_month(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "expired-expiry-access"
    calls: list[dict] = []

    def provider_get(url: str, **kwargs):
        params = kwargs["params"]
        calls.append(params)
        if params["range_to"] > "2025-02-28":
            request = fyers.httpx.Request("GET", url)
            response = fyers.httpx.Response(
                422,
                json={"s": "error", "message": "Invalid input"},
                request=request,
            )
            response.raise_for_status()
        expiry = {
            "2025-01-31": "2025-01-28",
            "2025-02-28": "2025-02-25",
        }.get(params["range_to"])
        return fyers.httpx.Response(
            200,
            json={
                "s": "ok",
                "data": {
                    "expiry_dates": {
                        "futures": [],
                        "options": [expiry] if expiry else [],
                    }
                },
            },
            request=fyers.httpx.Request("GET", url),
        )

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        access_token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/expired/expiry-dates",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "range_from": "2025-01-01",
                "range_to": "2025-03-31",
            },
            headers={"Authorization": f"Bearer {access_token}"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "symbol": "NSE:NIFTY50-INDEX",
        "futures": [],
        "options": ["2025-01-28", "2025-02-25"],
        "warnings": [
            "FYERS rejected some date-range segments; only expiries from supported "
            "segments are listed."
        ],
    }
    assert len(calls) == 4
    assert calls[0]["range_from"] == "2025-01-01"
    assert calls[0]["range_to"] == "2025-03-31"


def test_expired_contracts_are_separated_and_exchange_scoped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "s": "ok",
                "data": {
                    "contracts": {
                        "futures": ["NSE:NIFTY25MARFUT", "BSE:IGNORED-FUT"],
                        "options": [
                            "NSE:NIFTY25MAR23000CE",
                            {"symbol": "NSE:NIFTY25MAR23000PE"},
                            "bad contract",
                        ],
                    }
                },
            }

    monkeypatch.setattr(fyers.httpx, "get", lambda *args, **kwargs: ProviderResponse())
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(b"expired-contract-token").decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/expired/contracts",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "expiry_date": "2025-03-27",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "symbol": "NSE:NIFTY50-INDEX",
        "expiry_date": "2025-03-27",
        "futures": ["NSE:NIFTY25MARFUT"],
        "options": ["NSE:NIFTY25MAR23000CE", "NSE:NIFTY25MAR23000PE"],
    }


def test_expired_history_normalizes_candles_and_open_interest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "expired-history-access"

    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "s": "ok",
                "symbol": "NSE:NIFTY25MAR23000CE",
                "resolution": "5",
                "columns": [
                    "timestamp",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    "open_interest",
                ],
                "candles": [
                    [1742975100, 100, 110, 95, 105, 500, 3200],
                    [1742975400, 110, 105, 90, 100, 400, 3100],
                    ["invalid", 100, 110, 90, 105, 500, 3200],
                ],
            }

    calls: list[dict] = []

    def provider_get(*args, **kwargs):
        calls.append(kwargs)
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.get(
            "/admin/fyers/expired/history",
            params={
                "symbol": "NSE:NIFTY25MAR23000CE",
                "resolution": "5",
                "range_from": "2025-03-26",
                "range_to": "2025-03-27",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json()["candles"] == [
        {
            "time": 1742975100,
            "open": 100,
            "high": 110,
            "low": 95,
            "close": 105,
            "volume": 500,
            "open_interest": 3200,
        }
    ]
    assert calls[0]["params"] == {
        "symbol": "NSE:NIFTY25MAR23000CE",
        "resolution": "5",
        "date_format": "1",
        "range_from": "2025-03-26",
        "range_to": "2025-03-27",
        "include_oi": "1",
    }
    assert provider_token not in response.text


def test_expired_data_endpoints_are_admin_only_and_validate_ranges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fyers.httpx,
        "get",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("Invalid or unauthorized requests must not call FYERS")
        ),
    )
    with TestClient(app) as client:
        user_token = _token(client, "user@example.com")
        forbidden = client.get(
            "/admin/fyers/expired/expiry-dates",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "range_from": "2025-01-01",
                "range_to": "2025-01-02",
            },
            headers={"Authorization": f"Bearer {user_token}"},
        )
        invalid_range = client.get(
            "/admin/fyers/expired/history",
            params={
                "symbol": "NSE:NIFTY25MAR23000CE",
                "resolution": "D",
                "range_from": "2025-01-01",
                "range_to": "2025-01-02",
            },
            headers={"Authorization": f"Bearer {_token(client, 'admin@example.com')}"},
        )
        oversized_range = client.get(
            "/admin/fyers/expired/history",
            params={
                "symbol": "NSE:NIFTY25MAR23000CE",
                "range_from": "2024-01-01",
                "range_to": "2025-01-01",
            },
            headers={"Authorization": f"Bearer {_token(client, 'admin@example.com')}"},
        )

    assert forbidden.status_code == 403
    assert invalid_range.status_code == 422
    assert oversized_range.status_code == 422


def test_expired_provider_http_error_is_diagnosable_without_token_leak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "sensitive-provider-token"
    request = fyers.httpx.Request(
        "GET", "https://api-t1.fyers.in/data/history/fno/expired/expiry-dates"
    )
    response = fyers.httpx.Response(
        401,
        json={"s": "error", "message": "Invalid access token"},
        request=request,
    )

    def provider_get(*args, **kwargs):
        raise fyers.httpx.HTTPStatusError(
            "provider error", request=request, response=response
        )

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with pytest.raises(fyers.HTTPException) as raised:
        fyers._fyers_expired_data(
            "expiry-dates",
            {"symbol": "NSE:NIFTY50-INDEX"},
            provider_token,
        )

    assert raised.value.status_code == 502
    assert raised.value.detail == (
        "Expired market-data service returned HTTP 401: Invalid access token"
    )
    assert provider_token not in str(raised.value.detail)


def test_expired_chain_history_aligns_selected_expiry_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "expired-chain-history-access"
    call_symbol = "NSE:NIFTY25MAR23000CE"
    put_symbol = "NSE:NIFTY25MAR23000PE"
    requests: list[tuple[str, dict[str, str]]] = []

    def expired_data(endpoint: str, params: dict[str, str], _access_token: str) -> dict:
        requests.append((endpoint, params))
        if endpoint == "underlying-symbols":
            return {
                "s": "ok",
                "data": {
                    "contracts": {
                        "options": [call_symbol, put_symbol],
                        "futures": [],
                    }
                },
            }
        return {
            "s": "ok",
            "symbol": params["symbol"],
            "resolution": params["resolution"],
            "columns": [
                "timestamp",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "open_interest",
            ],
            "candles": [[1742975100, 100, 110, 95, 105, 500, 3200]],
        }

    monkeypatch.setattr(fyers, "_fyers_expired_data", expired_data)
    monkeypatch.setattr(
        fyers, "_decrypt_access_token", lambda _connection: provider_token
    )
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        catalog_response = client.get(
            "/admin/fyers/expired/contracts",
            params={
                "symbol": "NSE:NIFTY50-INDEX",
                "expiry_date": "2025-03-27",
            },
            headers={"Authorization": "Bearer " + token},
        )
        assert catalog_response.status_code == 200
        response = client.post(
            "/admin/fyers/expired/chain-history",
            params={
                "underlying_symbol": "NSE:NIFTY50-INDEX",
                "expiry_date": "2025-03-27",
                "resolution": "5",
                "range_from": "2025-03-26",
                "range_to": "2025-03-27",
            },
            json=[call_symbol, put_symbol],
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert [item["symbol"] for item in payload["contracts"]] == [
        call_symbol,
        put_symbol,
    ]
    assert all(
        item["candles"][0]["open_interest"] == 3200
        for item in payload["contracts"]
    )
    assert [endpoint for endpoint, _ in requests].count("historical-data") == 2
    assert [endpoint for endpoint, _ in requests].count("underlying-symbols") == 1
    assert all(
        params["include_oi"] == "1"
        for endpoint, params in requests
        if endpoint == "historical-data"
    )


def test_expired_chain_history_rejects_contract_not_in_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def expired_data(endpoint: str, _params: dict, _access_token: str) -> dict:
        nonlocal calls
        calls += 1
        assert endpoint == "underlying-symbols"
        return {
            "s": "ok",
            "data": {"contracts": {"options": ["NSE:NIFTY25MAR23000CE"]}},
        }

    monkeypatch.setattr(fyers, "_fyers_expired_data", expired_data)
    monkeypatch.setattr(fyers, "_decrypt_access_token", lambda _connection: "token")
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(b"token").decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        response = client.post(
            "/admin/fyers/expired/chain-history",
            params={
                "underlying_symbol": "NSE:NIFTY50-INDEX",
                "expiry_date": "2025-03-27",
                "range_from": "2025-03-26",
                "range_to": "2025-03-27",
            },
            json=["NSE:NIFTY25MAR23500CE"],
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Contract does not belong to the selected expiry"
    )
    assert calls == 1


def test_option_chain_symbols_follow_fyers_underlying_formats() -> None:
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        response = client.get(
            "/admin/fyers/option-chain/symbols",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    entries = response.json()["symbols"]
    symbols = {item["symbol"] for item in entries}
    equity_symbols = {
        item["symbol"] for item in entries if item["type"] == "Equity"
    }
    assert "NSE:NIFTY50-INDEX" in symbols
    assert "NSE:NIFTYBANK-INDEX" in symbols
    assert "NSE:SBIN-EQ" in symbols
    assert "NSE:SBILIFE-EQ" in equity_symbols
    assert "NSE:TMPV-EQ" in equity_symbols
    assert "NSE:HEROMOTOCO-EQ" not in equity_symbols
    assert "NSE:TATAMOTORS-EQ" not in equity_symbols
    assert len(equity_symbols) == 50


def test_option_chain_lot_sizes_use_instrument_master(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ProviderResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "NSE:NIFTY26OCT25000CE": {"minLotSize": 25},
                "NSE:NIFTY26OCT25100PE": {"minLotSize": 25},
            }

    requests: list[tuple[tuple, dict]] = []

    def provider_get(*args, **kwargs):
        requests.append((args, kwargs))
        return ProviderResponse()

    monkeypatch.setattr(fyers.httpx, "get", provider_get)
    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        response = client.post(
            "/admin/fyers/option-chain/lot-sizes",
            json=[
                "NSE:NIFTY26OCT25000CE",
                "NSE:NIFTY26OCT25100PE",
                "NSE:NIFTY26SEP25000CE",
            ],
            headers={"Authorization": "Bearer " + token},
        )

    assert response.status_code == 200
    assert response.json() == {
        "lot_sizes": {
            "NSE:NIFTY26OCT25000CE": 25,
            "NSE:NIFTY26OCT25100PE": 25,
            "NSE:NIFTY26SEP25000CE": None,
        }
    }
    assert requests[0][0][0] == (
        "https://public.fyers.in/sym_details/NSE_FO_sym_master.json"
    )


def test_option_chain_symbol_catalog_requires_admin() -> None:
    with TestClient(app) as client:
        token = _token(client, "user@example.com")
        response = client.get(
            "/admin/fyers/option-chain/symbols",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 403


def test_market_stream_ticket_is_short_lived_and_admin_only() -> None:
    with TestClient(app) as client:
        admin_token = _token(client, "admin@example.com")
        user_token = _token(client, "user@example.com")
        admin_response = client.post(
            "/admin/fyers/stream-ticket",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        user_response = client.post(
            "/admin/fyers/stream-ticket",
            headers={"Authorization": f"Bearer {user_token}"},
        )

    assert admin_response.status_code == 200
    claims = jwt.decode(
        admin_response.json()["ticket"],
        get_settings().secret_key,
        algorithms=[get_settings().jwt_algorithm],
    )
    assert claims["type"] == "market_stream"
    assert user_response.status_code == 403


def test_market_stream_subscribes_valid_contracts_and_relays_ticks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_token = "stream-access-token"
    expiry = "1790467200"
    underlying = "NSE:NIFTY50-INDEX"
    option_symbol = "NSE:NIFTY26SEP25000CE"
    discovery_data = {
        "expiryData": [{"date": "26-09-2026", "expiry": expiry, "expiry_flag": "W"}],
        "optionsChain": [],
    }
    selected_chain = {
        "expiryData": discovery_data["expiryData"],
        "optionsChain": [
            {"symbol": "", "option_type": "", "ltp": 25010},
            {
                "symbol": option_symbol,
                "option_type": "CE",
                "strike_price": 25000,
                "ltp": 123.4,
            },
        ],
    }
    chain_lookups: list[dict[str, str]] = []

    def fetch_chain(
        _endpoint: str, params: dict[str, str], _access_token: str
    ) -> dict:
        chain_lookups.append(params)
        return selected_chain if "timestamp" in params else discovery_data

    monkeypatch.setattr(
        fyers,
        "_fyers_data",
        fetch_chain,
    )
    monkeypatch.setattr(
        fyers, "_decrypt_access_token", lambda _connection: provider_token
    )
    fyers._shared_market_feed.cache_option_contracts(
        underlying, expiry, selected_chain
    )

    class FakeSocket:
        instances: list["FakeSocket"] = []

        def __init__(self, **kwargs) -> None:
            self.on_connect = kwargs["on_connect"]
            self.on_message = kwargs["on_message"]
            self.subscribed: list[str] = []
            self.instances.append(self)

        def connect(self) -> None:
            self.on_connect()
            self.on_message(
                {
                    "symbol": option_symbol,
                    "ltp": 123.45,
                    "vol_traded_today": 900,
                    "bid_price": 123.4,
                    "ask_price": 123.5,
                    "ch": 1.2,
                    "chp": 0.98,
                }
            )
            self.on_message(
                {
                    "symbol": option_symbol,
                    "ltp": 400,
                    "vol_traded_today": 1_000_000,
                }
            )

        def is_connected(self) -> bool:
            return True

        def subscribe(self, *, symbols: list[str], data_type: str) -> None:
            assert data_type == "SymbolUpdate"
            self.subscribed.extend(symbols)

        def unsubscribe(self, **_kwargs) -> None:
            return None

        def close_connection(self) -> None:
            return None

    sdk_package = ModuleType("fyers_apiv3")
    websocket_package = ModuleType("fyers_apiv3.FyersWebsocket")
    data_ws = ModuleType("fyers_apiv3.FyersWebsocket.data_ws")
    data_ws.FyersDataSocket = FakeSocket
    websocket_package.data_ws = data_ws
    sdk_package.FyersWebsocket = websocket_package
    monkeypatch.setitem(sys.modules, "fyers_apiv3", sdk_package)
    monkeypatch.setitem(sys.modules, "fyers_apiv3.FyersWebsocket", websocket_package)
    monkeypatch.setitem(sys.modules, "fyers_apiv3.FyersWebsocket.data_ws", data_ws)

    with TestClient(app) as client:
        token = _token(client, "admin@example.com")
        cipher = Fernet(get_settings().fyers_encryption_key.encode())
        with TestingSession() as db:
            db.add(
                BrokerConnection(
                    provider="fyers",
                    encrypted_access_token=cipher.encrypt(provider_token.encode()).decode(),
                    connected_by_user_id=1,
                )
            )
            db.commit()
        ticket = client.post(
            "/admin/fyers/stream-ticket",
            headers={"Authorization": f"Bearer {token}"},
        ).json()["ticket"]
        with client.websocket_connect("/admin/fyers/stream") as websocket:
            websocket.send_json(
                {
                    "ticket": ticket,
                    "symbol": underlying,
                    "timestamp": expiry,
                    "symbols": [underlying, option_symbol],
                }
            )
            received = [websocket.receive_json() for _ in range(6)]
            ticks = [message for message in received if message.get("type") == "tick"]
            tick = next(
                (message for message in ticks if message["ltp"] == 123.45), None
            )
            assert tick is not None, received
            assert tick["ltp"] == 123.45
            assert {message["ltp"] for message in ticks} == {
                123.45,
                400,
            }, received
            assert not any(message.get("type") == "warning" for message in received)

            with client.websocket_connect("/admin/fyers/stream") as second_websocket:
                second_websocket.send_json(
                    {
                        "ticket": ticket,
                        "symbol": underlying,
                        "timestamp": expiry,
                        "symbols": [underlying, option_symbol],
                    }
                )
                second_received = [
                    second_websocket.receive_json()
                    for _ in range(3)
                ]
                second_tick = next(
                    (
                        message
                        for message in second_received
                        if message.get("type") == "tick"
                    ),
                    None,
                )
                assert second_tick is not None, second_received
        assert len(FakeSocket.instances) == 1
    assert chain_lookups == []

    assert tick == {
        "type": "tick",
        "symbol": option_symbol,
        "ltp": 123.45,
        "volume": 900,
        "oi": None,
        "bid": 123.4,
        "ask": 123.5,
        "time": None,
        "change": 1.2,
        "change_percent": 0.98,
    }
