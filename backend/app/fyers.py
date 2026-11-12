"""Admin-only FYERS OAuth integration."""

import asyncio
import copy
import hashlib
import logging
import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone
from datetime import time as datetime_time
from email.utils import parsedate_to_datetime
from urllib.parse import urlencode

import httpx
import jwt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import RedirectResponse
from sqlalchemy import case, or_, select, update
from sqlalchemy.orm import Session

from app.auth import (
    admin_user,
    has_market_access,
    market_data_user,
    password_updated_user,
)
from app.config import get_settings
from app.db import SessionLocal, get_db
from app.models import BrokerConnection, FyersFeedSettings, FyersOAuthState, User
from app.schemas import FyersFeedSettingsUpdate, FyersStatus

router = APIRouter(prefix="/admin/fyers", tags=["admin FYERS"])
logger = logging.getLogger(__name__)
_fyers_token_refresh_lock = threading.Lock()
_expired_contract_catalog_lock = threading.Lock()
_expired_contract_catalog_cache: dict[tuple[str, str], tuple[float, set[str]]] = {}
_EXPIRED_CONTRACT_CATALOG_TTL = 900
_option_lot_size_lock = threading.Lock()
_option_lot_size_cache: dict[str, tuple[float, dict[str, int]]] = {}
_OPTION_LOT_SIZE_CACHE_TTL = 3600
_FYERS_FO_SYMBOL_MASTER_URL = "https://public.fyers.in/sym_details/{exchange}_FO_sym_master.json"
_FYERS_TIMEZONE = timezone(timedelta(hours=5, minutes=30))
_FYERS_DAILY_API_LIMIT = 5000
_market_status_lock = threading.Lock()
_market_status_cache: tuple[date, dict[str, str]] | None = None
_fyers_cooldown_lock = threading.Lock()
_fyers_cooldown_until = 0.0
_default_chain_refresh_lock = threading.Lock()
_default_chain_state_lock = threading.Lock()
_default_chain_snapshot: dict | None = None
_default_chain_updated_at: datetime | None = None
_default_chain_error: str | None = None
_feed_poller_stop = threading.Event()
_feed_poller_thread: threading.Thread | None = None
_feed_refresh_interval_seconds = 5
_option_chain_response_lock = threading.Lock()
_option_chain_response_cache: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_OPTION_CHAIN_RESPONSE_CACHE_TTL = 0.75
_expired_response_lock = threading.Lock()
_expired_response_cache: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_EXPIRED_RESPONSE_CACHE_TTL = 24 * 60 * 60
_history_response_lock = threading.Lock()
_history_response_cache: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_HISTORY_RESPONSE_CACHE_TTL = 5 * 60


def _record_fyers_api_request() -> None:
    today = datetime.now(_FYERS_TIMEZONE).date()
    with SessionLocal() as db:
        result = db.execute(
            update(FyersFeedSettings)
            .where(FyersFeedSettings.id == 1)
            .values(
                api_requests_date=today,
                api_requests_today=case(
                    (
                        FyersFeedSettings.api_requests_date == today,
                        FyersFeedSettings.api_requests_today + 1,
                    ),
                    else_=1,
                ),
            )
        )
        if result.rowcount != 1:
            raise RuntimeError(
                "Fyers feed settings are missing; run database migrations."
            )
        db.commit()


FYERS_OPTION_UNDERLYINGS = (
    {"label": "NIFTY 50", "symbol": "NSE:NIFTY50-INDEX", "type": "Index"},
    {"label": "NIFTY BANK", "symbol": "NSE:NIFTYBANK-INDEX", "type": "Index"},
    {
        "label": "NIFTY FINANCIAL SERVICES",
        "symbol": "NSE:FINNIFTY-INDEX",
        "type": "Index",
    },
    {"label": "NIFTY MIDCAP SELECT", "symbol": "NSE:MIDCPNIFTY-INDEX", "type": "Index"},
    {"label": "SENSEX", "symbol": "BSE:SENSEX-INDEX", "type": "Index"},
    {"label": "BANKEX", "symbol": "BSE:BANKEX-INDEX", "type": "Index"},
    {"label": "RELIANCE", "symbol": "NSE:RELIANCE-EQ", "type": "Equity"},
    {"label": "HDFC BANK", "symbol": "NSE:HDFCBANK-EQ", "type": "Equity"},
    {"label": "ICICI BANK", "symbol": "NSE:ICICIBANK-EQ", "type": "Equity"},
    {"label": "STATE BANK OF INDIA", "symbol": "NSE:SBIN-EQ", "type": "Equity"},
    {"label": "INFOSYS", "symbol": "NSE:INFY-EQ", "type": "Equity"},
    {"label": "TCS", "symbol": "NSE:TCS-EQ", "type": "Equity"},
    {"label": "AXIS BANK", "symbol": "NSE:AXISBANK-EQ", "type": "Equity"},
    {"label": "LARSEN & TOUBRO", "symbol": "NSE:LT-EQ", "type": "Equity"},
    {"label": "BAJAJ FINANCE", "symbol": "NSE:BAJFINANCE-EQ", "type": "Equity"},
    {"label": "BHARTI AIRTEL", "symbol": "NSE:BHARTIARTL-EQ", "type": "Equity"},
    {"label": "ITC", "symbol": "NSE:ITC-EQ", "type": "Equity"},
    {"label": "MARUTI SUZUKI", "symbol": "NSE:MARUTI-EQ", "type": "Equity"},
    {"label": "KOTAK MAHINDRA BANK", "symbol": "NSE:KOTAKBANK-EQ", "type": "Equity"},
    {"label": "SUN PHARMA", "symbol": "NSE:SUNPHARMA-EQ", "type": "Equity"},
    {
        "label": "TATA MOTORS PASSENGER VEHICLES",
        "symbol": "NSE:TMPV-EQ",
        "type": "Equity",
    },
    {"label": "TATA STEEL", "symbol": "NSE:TATASTEEL-EQ", "type": "Equity"},
    {"label": "WIPRO", "symbol": "NSE:WIPRO-EQ", "type": "Equity"},
    {"label": "HINDUSTAN UNILEVER", "symbol": "NSE:HINDUNILVR-EQ", "type": "Equity"},
    {"label": "ADANI ENTERPRISES", "symbol": "NSE:ADANIENT-EQ", "type": "Equity"},
    {"label": "POWER GRID", "symbol": "NSE:POWERGRID-EQ", "type": "Equity"},
    {"label": "ONGC", "symbol": "NSE:ONGC-EQ", "type": "Equity"},
    {"label": "NTPC", "symbol": "NSE:NTPC-EQ", "type": "Equity"},
    {"label": "TITAN", "symbol": "NSE:TITAN-EQ", "type": "Equity"},
    {"label": "ULTRATECH CEMENT", "symbol": "NSE:ULTRACEMCO-EQ", "type": "Equity"},
    {"label": "BAJAJ AUTO", "symbol": "NSE:BAJAJ-AUTO-EQ", "type": "Equity"},
    {"label": "TATA CONSUMER", "symbol": "NSE:TATACONSUM-EQ", "type": "Equity"},
    {"label": "JSW STEEL", "symbol": "NSE:JSWSTEEL-EQ", "type": "Equity"},
    {"label": "ADANI PORTS", "symbol": "NSE:ADANIPORTS-EQ", "type": "Equity"},
    {"label": "APOLLO HOSPITALS", "symbol": "NSE:APOLLOHOSP-EQ", "type": "Equity"},
    {"label": "ASIAN PAINTS", "symbol": "NSE:ASIANPAINT-EQ", "type": "Equity"},
    {"label": "BAJAJ FINSERV", "symbol": "NSE:BAJAJFINSV-EQ", "type": "Equity"},
    {"label": "BHARAT ELECTRONICS", "symbol": "NSE:BEL-EQ", "type": "Equity"},
    {"label": "CIPLA", "symbol": "NSE:CIPLA-EQ", "type": "Equity"},
    {"label": "COAL INDIA", "symbol": "NSE:COALINDIA-EQ", "type": "Equity"},
    {"label": "DR REDDY'S LABORATORIES", "symbol": "NSE:DRREDDY-EQ", "type": "Equity"},
    {"label": "EICHER MOTORS", "symbol": "NSE:EICHERMOT-EQ", "type": "Equity"},
    {"label": "GRASIM INDUSTRIES", "symbol": "NSE:GRASIM-EQ", "type": "Equity"},
    {"label": "HCLTECH", "symbol": "NSE:HCLTECH-EQ", "type": "Equity"},
    {"label": "HDFC LIFE", "symbol": "NSE:HDFCLIFE-EQ", "type": "Equity"},
    {"label": "SBI LIFE INSURANCE", "symbol": "NSE:SBILIFE-EQ", "type": "Equity"},
    {"label": "HINDALCO", "symbol": "NSE:HINDALCO-EQ", "type": "Equity"},
    {"label": "INTERGLOBE AVIATION", "symbol": "NSE:INDIGO-EQ", "type": "Equity"},
    {"label": "JIO FINANCIAL SERVICES", "symbol": "NSE:JIOFIN-EQ", "type": "Equity"},
    {"label": "MAHINDRA & MAHINDRA", "symbol": "NSE:M&M-EQ", "type": "Equity"},
    {"label": "MAX HEALTHCARE", "symbol": "NSE:MAXHEALTH-EQ", "type": "Equity"},
    {"label": "NESTLE INDIA", "symbol": "NSE:NESTLEIND-EQ", "type": "Equity"},
    {"label": "SHRIRAM FINANCE", "symbol": "NSE:SHRIRAMFIN-EQ", "type": "Equity"},
    {"label": "TECH MAHINDRA", "symbol": "NSE:TECHM-EQ", "type": "Equity"},
    {"label": "TRENT", "symbol": "NSE:TRENT-EQ", "type": "Equity"},
    {"label": "ETERNAL", "symbol": "NSE:ETERNAL-EQ", "type": "Equity"},
)
FYERS_NSE_EXCHANGE_ID = 10
FYERS_FO_SEGMENT_ID = 11


@dataclass
class _StreamSubscriber:
    loop: asyncio.AbstractEventLoop
    events: asyncio.Queue[dict]
    symbols: set[str]


@dataclass
class _ProviderStream:
    socket: object | None = None
    symbols: set[str] = field(default_factory=set)
    operation_lock: threading.Lock = field(default_factory=threading.Lock)
    connected: bool = False
    retired: bool = False
    readiness_monitor_running: bool = False


class _SharedMarketFeed:
    """Multiplex licensed browser sessions over shared FYERS provider streams."""

    _quote_max_age_seconds = 24 * 60 * 60

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers: dict[str, _StreamSubscriber] = {}
        self._streams: list[_ProviderStream] = []
        self._latest: OrderedDict[str, dict] = OrderedDict()
        self._chain_snapshots: dict[
            tuple[str, str], tuple[float, dict]
        ] = {}
        self._option_contracts: dict[
            tuple[str, str], tuple[float, frozenset[str]]
        ] = {}
        self._access_token: str | None = None

    def _deliver(self, subscriber: _StreamSubscriber, event: dict) -> None:
        def enqueue() -> None:
            if subscriber.events.full():
                try:
                    subscriber.events.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            subscriber.events.put_nowait(event)

        try:
            subscriber.loop.call_soon_threadsafe(enqueue)
        except RuntimeError:
            logger.debug("Market stream subscriber event loop has closed")

    def _broadcast(self, event: dict) -> None:
        for subscriber in tuple(self._subscribers.values()):
            self._deliver(subscriber, event)

    def _connection_status(self) -> str:
        return (
            "connected"
            if self._streams and all(stream.connected for stream in self._streams)
            else "reconnecting"
        )

    def cache_option_contracts(
        self, underlying: str, expiry: str, chain_data: dict
    ) -> None:
        option_chain = chain_data.get("optionsChain")
        if not isinstance(option_chain, list):
            return
        contracts = frozenset(
            item["symbol"]
            for item in option_chain
            if isinstance(item, dict)
            and item.get("option_type") in {"CE", "PE"}
            and isinstance(item.get("symbol"), str)
        )
        if not contracts:
            return
        now = time.monotonic()
        with self._lock:
            self._option_contracts = {
                key: entry
                for key, entry in self._option_contracts.items()
                if entry[0] > now
            }
            self._option_contracts[(underlying, expiry)] = (
                now + 24 * 60 * 60,
                contracts,
            )

    def cached_option_contracts(
        self, underlying: str, expiry: str
    ) -> set[str] | None:
        with self._lock:
            entry = self._option_contracts.get((underlying, expiry))
            if entry is None:
                return None
            if entry[0] <= time.monotonic():
                self._option_contracts.pop((underlying, expiry), None)
                return None
            return set(entry[1])

    def cache_chain_snapshot(
        self, underlying: str, expiry: str, snapshot: dict
    ) -> None:
        now = time.monotonic()
        with self._lock:
            self._chain_snapshots = {
                key: entry
                for key, entry in self._chain_snapshots.items()
                if entry[0] > now
            }
            self._chain_snapshots[(underlying, expiry)] = (
                now + 24 * 60 * 60,
                copy.deepcopy(snapshot),
            )

    def cached_chain_snapshot(
        self, underlying: str, expiry: str | None = None
    ) -> dict | None:
        now = time.monotonic()
        with self._lock:
            self._chain_snapshots = {
                key: entry
                for key, entry in self._chain_snapshots.items()
                if entry[0] > now
            }
            if expiry is not None:
                entry = self._chain_snapshots.get((underlying, expiry))
            else:
                candidates = [
                    (key, entry)
                    for key, entry in self._chain_snapshots.items()
                    if key[0] == underlying
                ]
                entry = (
                    max(candidates, key=lambda item: item[1][0])[1]
                    if candidates
                    else None
                )
            return copy.deepcopy(entry[1]) if entry is not None else None

    def latest_quote(self, symbol: str) -> dict | None:
        with self._lock:
            event = self._latest_event(symbol)
            if event is None:
                return None
            message = event.get("message")
            return message.copy() if isinstance(message, dict) else None

    def _latest_event(self, symbol: str) -> dict | None:
        event = self._latest.get(symbol)
        if event is None:
            return None
        cached_at = event.get("_cached_at")
        if (
            not isinstance(cached_at, (int, float))
            or time.monotonic() - cached_at > self._quote_max_age_seconds
        ):
            self._latest.pop(symbol, None)
            return None
        return event

    def _start_stream(self, stream: _ProviderStream, access_token: str) -> None:
        try:
            from fyers_apiv3.FyersWebsocket import data_ws
        except ImportError:
            logger.exception("FYERS WebSocket SDK is not installed")
            raise HTTPException(
                status_code=503, detail="Live market streaming is unavailable"
            ) from None

        def on_connect() -> None:
            with self._lock:
                if stream.retired or stream.readiness_monitor_running:
                    return
                stream.readiness_monitor_running = True

            def subscribe_when_ready() -> None:
                try:
                    while not stream.retired:
                        socket = stream.socket
                        if socket is not None and socket.is_connected():
                            with self._lock:
                                if stream.retired or socket is not stream.socket:
                                    return
                                symbols = set(stream.symbols)
                            if symbols:
                                self._schedule_subscription(stream, symbols)
                            return
                        time.sleep(0.25)
                except Exception:
                    logger.exception("Unable to monitor FYERS socket readiness")
                finally:
                    with self._lock:
                        stream.readiness_monitor_running = False

            threading.Thread(
                target=subscribe_when_ready,
                name="fyers-subscription-ready",
                daemon=True,
            ).start()

        def on_message(message: object) -> None:
            if not isinstance(message, dict):
                return
            updated_symbol = message.get("symbol")
            if not isinstance(updated_symbol, str):
                return
            event = {
                "type": "provider",
                "message": message,
                "_cached_at": time.monotonic(),
            }
            with self._lock:
                if stream.retired:
                    return
                self._latest[updated_symbol] = event
                self._latest.move_to_end(updated_symbol)
                while len(self._latest) > 20_000:
                    self._latest.popitem(last=False)
                for subscriber in tuple(self._subscribers.values()):
                    if updated_symbol in subscriber.symbols:
                        self._deliver(subscriber, event)

        def on_error(message: object) -> None:
            del message
            logger.warning("FYERS market socket reported an error; reconnecting")
            with self._lock:
                if stream.retired:
                    return
                stream.connected = False
                self._broadcast({"type": "status", "status": "reconnecting"})

        def on_close(_message: object) -> None:
            with self._lock:
                if stream.retired:
                    return
                stream.connected = False
                self._broadcast({"type": "status", "status": "reconnecting"})

        stream.socket = data_ws.FyersDataSocket(
            access_token=f"{get_settings().fyers_client_id}:{access_token}",
            log_path="",
            litemode=False,
            write_to_file=False,
            reconnect=True,
            on_connect=on_connect,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        threading.Thread(
            target=stream.socket.connect,
            name="fyers-shared-market-stream",
            daemon=True,
        ).start()

    def _add_symbols(self, symbols: set[str], access_token: str) -> None:
        for symbol in symbols:
            stream = next(
                (item for item in self._streams if symbol in item.symbols), None
            )
            if stream is not None:
                continue
            stream = next(
                (item for item in self._streams if len(item.symbols) < 200), None
            )
            if stream is None:
                stream = _ProviderStream()
                self._streams.append(stream)
            stream.symbols.add(symbol)
            if stream.socket is None:
                self._start_stream(stream, access_token)
            else:
                self._schedule_subscription(stream, {symbol})

    def _schedule_subscription(
        self, stream: _ProviderStream, symbols: set[str]
    ) -> None:
        def subscribe() -> None:
            with stream.operation_lock:
                with self._lock:
                    if stream.retired:
                        return
                    socket = stream.socket
                    requested = sorted(symbols.intersection(stream.symbols))
                if socket is None or not requested:
                    return
                try:
                    if not socket.is_connected():
                        return
                    socket.subscribe(
                        symbols=requested, data_type="SymbolUpdate"
                    )
                except Exception:
                    with self._lock:
                        if stream.retired or socket is not stream.socket:
                            return
                        stream.connected = False
                        self._broadcast(
                            {"type": "status", "status": "reconnecting"}
                        )
                    logger.exception("Unable to subscribe to shared FYERS feed")
                    return
                with self._lock:
                    if stream.retired or socket is not stream.socket:
                        return
                    stream.connected = True
                    self._broadcast(
                        {
                            "type": "status",
                            "status": self._connection_status(),
                        }
                    )

        threading.Thread(
            target=subscribe,
            name="fyers-symbol-subscription",
            daemon=True,
        ).start()

    def _schedule_unsubscription(
        self, stream: _ProviderStream, symbols: set[str]
    ) -> None:
        def unsubscribe() -> None:
            with stream.operation_lock:
                with self._lock:
                    if stream.retired:
                        return
                    socket = stream.socket
                    removed = sorted(symbols - stream.symbols)
                if socket is None or not removed:
                    return
                try:
                    if socket.is_connected():
                        socket.unsubscribe(
                            symbols=removed, data_type="SymbolUpdate"
                        )
                except Exception:
                    logger.exception("Unable to unsubscribe from shared FYERS feed")

        threading.Thread(
            target=unsubscribe,
            name="fyers-symbol-unsubscription",
            daemon=True,
        ).start()

    def _schedule_close(self, stream: _ProviderStream) -> None:
        def close() -> None:
            with stream.operation_lock:
                socket = stream.socket
                if socket is None:
                    return
                try:
                    socket.close_connection()
                except Exception:
                    logger.exception("Unable to close shared FYERS stream")

        threading.Thread(
            target=close,
            name="fyers-market-stream-close",
            daemon=True,
        ).start()

    def add_subscriber(
        self,
        subscriber_id: str,
        loop: asyncio.AbstractEventLoop,
        events: asyncio.Queue[dict],
        symbols: set[str],
        access_token: str,
    ) -> None:
        with self._lock:
            if self._access_token is not None and self._access_token != access_token:
                self._stop_streams()
            self._access_token = access_token
            self._subscribers[subscriber_id] = _StreamSubscriber(
                loop=loop, events=events, symbols=set(symbols)
            )
            union = set().union(
                *(subscriber.symbols for subscriber in self._subscribers.values())
            )
            self._add_symbols(union, access_token)
            status = (
                self._connection_status()
                if any(stream.connected for stream in self._streams)
                else "connecting"
            )
            self._deliver(
                self._subscribers[subscriber_id],
                {"type": "status", "status": status},
            )
            for symbol in symbols:
                cached = self._latest_event(symbol)
                if cached is not None:
                    self._deliver(self._subscribers[subscriber_id], cached)

    def update_subscriber(self, subscriber_id: str, symbols: set[str]) -> None:
        with self._lock:
            subscriber = self._subscribers.get(subscriber_id)
            if subscriber is None:
                return
            subscriber.symbols = set(symbols)
            union = set().union(
                *(item.symbols for item in self._subscribers.values())
            )
            for stream in self._streams:
                removed = stream.symbols - union
                if removed:
                    self._schedule_unsubscription(stream, removed)
                stream.symbols.intersection_update(union)
            empty_streams = [stream for stream in self._streams if not stream.symbols]
            self._streams = [
                stream for stream in self._streams if stream.symbols
            ]
            for stream in empty_streams:
                stream.retired = True
                self._schedule_close(stream)
            if self._access_token is not None:
                self._add_symbols(union, self._access_token)
            for symbol in symbols:
                cached = self._latest_event(symbol)
                if cached is not None:
                    self._deliver(subscriber, cached)

    def remove_subscriber(self, subscriber_id: str) -> None:
        with self._lock:
            self._subscribers.pop(subscriber_id, None)
            union = set().union(
                *(item.symbols for item in self._subscribers.values())
            ) if self._subscribers else set()
            if not self._subscribers:
                self._stop_streams()
                self._access_token = None
                return
            for stream in self._streams:
                removed = stream.symbols - union
                if removed:
                    self._schedule_unsubscription(stream, removed)
                stream.symbols.intersection_update(union)
            empty_streams = [stream for stream in self._streams if not stream.symbols]
            self._streams = [stream for stream in self._streams if stream.symbols]
            for stream in empty_streams:
                stream.retired = True
                self._schedule_close(stream)

    def _stop_streams(self) -> None:
        streams, self._streams = self._streams, []
        for stream in streams:
            stream.retired = True
            self._schedule_close(stream)


_shared_market_feed = _SharedMarketFeed()


def app_id_hash(client_id: str, client_secret: str) -> str:
    """Build the hash required by FYERS validate-authcode."""

    return hashlib.sha256(f"{client_id}:{client_secret}".encode()).hexdigest()


def _cipher() -> Fernet:
    key = get_settings().fyers_encryption_key.strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="FYERS_ENCRYPTION_KEY must be configured before connecting FYERS",
        )
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as error:
        raise HTTPException(
            status_code=503, detail="Invalid FYERS encryption key"
        ) from error


def _hash_state(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _provider_configured() -> None:
    settings = get_settings()
    if (
        not settings.fyers_client_id
        or not settings.fyers_client_secret
        or not settings.fyers_redirect_uri
    ):
        raise HTTPException(
            status_code=503, detail="FYERS OAuth settings are incomplete"
        )


def _without_tokens(value: object, access_token: str) -> object:
    """Keep credentials out of provider payloads before returning them."""

    if isinstance(value, dict):
        return {
            key: _without_tokens(item, access_token)
            for key, item in value.items()
            if key.lower() not in {"access_token", "refresh_token", "token"}
        }
    if isinstance(value, list):
        return [_without_tokens(item, access_token) for item in value]
    if isinstance(value, str):
        return value.replace(access_token, "[redacted]")
    return value


def _decrypt_access_token(connection: BrokerConnection) -> str:
    try:
        return _cipher().decrypt(connection.encrypted_access_token.encode()).decode()
    except (InvalidToken, UnicodeDecodeError) as error:
        raise HTTPException(
            status_code=502, detail="Stored FYERS credentials could not be read"
        ) from error


def _decrypt_refresh_token(connection: BrokerConnection) -> str:
    if not connection.encrypted_refresh_token:
        raise HTTPException(
            status_code=503,
            detail="FYERS refresh token is unavailable; reconnect the market account",
        )
    try:
        return _cipher().decrypt(connection.encrypted_refresh_token.encode()).decode()
    except (InvalidToken, UnicodeDecodeError) as error:
        raise HTTPException(
            status_code=502, detail="Stored FYERS credentials could not be read"
        ) from error


def _access_token_expiring(access_token: str) -> bool:
    try:
        claims = jwt.decode(
            access_token,
            options={"verify_signature": False, "verify_exp": False},
        )
    except jwt.InvalidTokenError:
        return False
    expiry = _number(claims.get("exp"))
    return expiry is not None and expiry <= datetime.now(UTC).timestamp() + 300


def _refresh_fyers_access_token(
    connection: BrokerConnection, db: Session
) -> str:
    settings = get_settings()
    if not settings.fyers_pin:
        raise HTTPException(
            status_code=503,
            detail="FYERS_PIN must be configured for automatic market-token refresh",
        )

    previous_access_token = connection.encrypted_access_token
    with _fyers_token_refresh_lock:
        db.refresh(connection)
        if connection.encrypted_access_token != previous_access_token:
            return _decrypt_access_token(connection)

        refresh_token = _decrypt_refresh_token(connection)
        try:
            _ensure_fyers_api_available()
            _record_fyers_api_request()
            response = httpx.post(
                f"{settings.fyers_api_base_url.rstrip('/')}/api/v3/validate-refresh-token",
                json={
                    "grant_type": "refresh_token",
                    "appIdHash": app_id_hash(
                        settings.fyers_client_id, settings.fyers_client_secret
                    ),
                    "refresh_token": refresh_token,
                    "pin": settings.fyers_pin,
                },
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 429:
                _raise_fyers_rate_limit(error, "token refresh")
            logger.warning(
                "FYERS token refresh was rejected with HTTP %s",
                error.response.status_code,
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    "FYERS token refresh failed; verify the FYERS PIN and "
                    "refresh-token validity"
                ),
            ) from error
        except httpx.RequestError as error:
            logger.exception("Unable to reach FYERS token refresh service")
            raise HTTPException(
                status_code=502,
                detail="Unable to reach FYERS token refresh service",
            ) from error
        except ValueError as error:
            raise HTTPException(
                status_code=502,
                detail="FYERS returned invalid JSON during token refresh",
            ) from error

        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=502,
                detail="FYERS returned an invalid token refresh response",
            )
        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise HTTPException(
                status_code=502,
                detail="FYERS token refresh response did not contain an access token",
            )

        cipher = _cipher()
        connection.encrypted_access_token = cipher.encrypt(
            access_token.encode()
        ).decode()
        rotated_refresh_token = payload.get("refresh_token")
        if isinstance(rotated_refresh_token, str) and rotated_refresh_token:
            connection.encrypted_refresh_token = cipher.encrypt(
                rotated_refresh_token.encode()
            ).decode()
        connection.updated_at = datetime.now(UTC)
        db.commit()
        return access_token


def _get_access_token(connection: BrokerConnection, db: Session) -> str:
    access_token = _decrypt_access_token(connection)
    if _access_token_expiring(access_token):
        return _refresh_fyers_access_token(connection, db)
    return access_token


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _ensure_fyers_api_available() -> None:
    with _fyers_cooldown_lock:
        remaining = max(0, math.ceil(_fyers_cooldown_until - time.monotonic()))
    if remaining:
        raise HTTPException(
            status_code=503,
            detail="Fyers rate limit reached; market-data requests are paused.",
            headers={"Retry-After": str(remaining)},
        )


def _next_fyers_market_open(now: datetime) -> datetime:
    next_open = now.replace(hour=9, minute=15, second=0, microsecond=0)
    if now >= next_open:
        next_open += timedelta(days=1)
    while next_open.weekday() >= 5:
        next_open += timedelta(days=1)
    return next_open


def _raise_fyers_rate_limit(error: httpx.HTTPStatusError, operation: str) -> None:
    global _fyers_cooldown_until
    response = error.response
    retry_after = response.headers.get("Retry-After")
    if retry_after is None:
        delay = 300
    else:
        try:
            delay = max(1, int(retry_after))
        except ValueError:
            try:
                retry_time = parsedate_to_datetime(retry_after)
                if retry_time.tzinfo is None:
                    retry_time = retry_time.replace(tzinfo=UTC)
                delay = max(
                    1,
                    math.ceil((retry_time - datetime.now(UTC)).total_seconds()),
                )
            except (TypeError, ValueError, OverflowError):
                delay = 300
    try:
        body = response.json()
    except ValueError:
        body = None
    provider_message = (
        " ".join(
            value
            for value in body.values()
            if isinstance(value, str)
        ).lower()
        if isinstance(body, dict)
        else ""
    )
    daily_limit = "daily" in provider_message or "per day" in provider_message
    if daily_limit:
        now = datetime.now(_FYERS_TIMEZONE)
        next_market_day = _next_fyers_market_open(now)
        delay = max(delay, math.ceil((next_market_day - now).total_seconds()))
    if not daily_limit:
        delay = min(delay, 6 * 60 * 60)
    with _fyers_cooldown_lock:
        _fyers_cooldown_until = max(
            _fyers_cooldown_until, time.monotonic() + delay
        )
    logger.warning(
        "FYERS rate-limited %s; pausing requests for at least %s seconds",
        operation,
        delay,
    )
    raise HTTPException(
        status_code=503,
        detail="Fyers rate limit reached; market-data requests are paused.",
        headers={"Retry-After": str(delay)},
    ) from error


def _fyers_data(
    endpoint: str, params: dict[str, str], access_token: str
) -> dict:
    key = (endpoint, tuple(sorted(params.items())))
    with _option_chain_response_lock:
        now = time.monotonic()
        cached = _option_chain_response_cache.get(key)
        if (
            cached is not None
            and now - cached[0] < _OPTION_CHAIN_RESPONSE_CACHE_TTL
        ):
            _option_chain_response_cache.move_to_end(key)
            return copy.deepcopy(cached[1])
        payload = _fetch_fyers_data(endpoint, params, access_token)
        _option_chain_response_cache[key] = (time.monotonic(), copy.deepcopy(payload))
        while len(_option_chain_response_cache) > 256:
            _option_chain_response_cache.popitem(last=False)
        return payload


def _fetch_fyers_data(
    endpoint: str, params: dict[str, str], access_token: str
) -> dict:
    _ensure_fyers_api_available()
    settings = get_settings()
    try:
        _record_fyers_api_request()
        response = httpx.get(
            f"{settings.fyers_api_base_url.rstrip('/')}/data/{endpoint}",
            params=params,
            headers={
                "Authorization": f"{settings.fyers_client_id}:{access_token}"
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 429:
            _raise_fyers_rate_limit(error, endpoint)
        raise HTTPException(
            status_code=502, detail="FYERS market-data request failed"
        ) from error
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(
            status_code=502, detail="FYERS market-data request failed"
        ) from error
    if not isinstance(payload, dict) or payload.get("s") != "ok":
        raise HTTPException(status_code=502, detail="FYERS market-data request failed")
    data = payload.get("data")
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("expiryData"), list)
        or not isinstance(data.get("optionsChain"), list)
    ):
        raise HTTPException(
            status_code=502, detail="FYERS returned an invalid market-data response"
        )
    return data


def _fyers_now() -> datetime:
    return datetime.now(_FYERS_TIMEZONE)


def _fyers_option_market_status(
    access_token: str, db: Session
) -> dict[str, str]:
    global _market_status_cache
    with _market_status_lock:
        now = _fyers_now()
        today = now.date()
        if now.weekday() >= 5:
            return _market_status_result("CLOSED")
        if now.time() < datetime_time(9, 16):
            return _market_status_result("UNKNOWN")
        if now.time() >= datetime_time(15, 30):
            return _market_status_result("CLOSED")

        if _market_status_cache is not None and _market_status_cache[0] == today:
            return _market_status_cache[1].copy()

        settings = db.get(FyersFeedSettings, 1)
        if settings is not None and settings.market_status_checked_on == today:
            status = settings.market_status or "UNKNOWN"
            result = _market_status_result(status)
            _market_status_cache = (today, result)
            return _effective_market_status(result, now)

        if settings is None:
            settings = FyersFeedSettings(id=1, refresh_interval_seconds=5)
            db.add(settings)
            db.commit()
            db.refresh(settings)

        result = db.execute(
            update(FyersFeedSettings)
            .where(
                FyersFeedSettings.id == 1,
                or_(
                    FyersFeedSettings.market_status_checked_on.is_(None),
                    FyersFeedSettings.market_status_checked_on != today,
                ),
            )
            .values(market_status_checked_on=today, market_status="UNKNOWN")
        )
        db.commit()
        if result.rowcount != 1:
            db.refresh(settings)
            cached = _market_status_result(settings.market_status or "UNKNOWN")
            _market_status_cache = (today, cached)
            return _effective_market_status(cached, now)

        try:
            _ensure_fyers_api_available()
            status = _fetch_fyers_option_market_status(access_token)
        except HTTPException:
            settings = db.get(FyersFeedSettings, 1)
            if settings is not None:
                settings.market_status = "UNAVAILABLE"
                db.commit()
            unavailable = _market_status_result("UNAVAILABLE")
            _market_status_cache = (today, unavailable)
            raise

        settings = db.get(FyersFeedSettings, 1)
        if settings is not None:
            settings.market_status = status["status"]
            db.commit()
        _market_status_cache = (today, status)
        return _effective_market_status(status, now)


def _market_status_result(status: str) -> dict[str, str]:
    return {
        "exchange": "NSE",
        "segment": "FO",
        "market_type": "NORMAL",
        "status": status,
    }


def _effective_market_status(
    status: dict[str, str], now: datetime
) -> dict[str, str]:
    result = status.copy()
    if now.weekday() >= 5 or now.time() >= datetime_time(15, 30):
        result["status"] = "CLOSED"
    return result


def _fetch_fyers_option_market_status(access_token: str) -> dict[str, str]:
    settings = get_settings()
    try:
        _record_fyers_api_request()
        response = httpx.get(
            f"{settings.fyers_api_base_url.rstrip('/')}/data/marketStatus",
            headers={
                "Authorization": f"{settings.fyers_client_id}:{access_token}"
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 429:
            _raise_fyers_rate_limit(error, "market status")
        logger.warning(
            "FYERS market-status request failed with HTTP %s",
            error.response.status_code,
        )
        raise HTTPException(
            status_code=502, detail="Unable to retrieve market status from FYERS"
        ) from error
    except (httpx.RequestError, ValueError) as error:
        logger.exception("Unable to retrieve market status from FYERS")
        raise HTTPException(
            status_code=502, detail="Unable to retrieve market status from FYERS"
        ) from error

    market_statuses = (
        payload.get("marketStatus") if isinstance(payload, dict) else None
    )
    if (
        not isinstance(payload, dict)
        or payload.get("s") != "ok"
        or not isinstance(market_statuses, list)
    ):
        raise HTTPException(
            status_code=502, detail="FYERS returned an invalid market-status response"
        )

    nse_derivatives_status = next(
        (
            item
            for item in market_statuses
            if isinstance(item, dict)
            and item.get("exchange") == FYERS_NSE_EXCHANGE_ID
            and item.get("segment") == FYERS_FO_SEGMENT_ID
            and item.get("market_type") == "NORMAL"
        ),
        None,
    )
    status = (
        nse_derivatives_status.get("status")
        if nse_derivatives_status is not None
        else None
    )
    if not isinstance(status, str) or not status.strip():
        raise HTTPException(
            status_code=502,
            detail="FYERS did not return NSE derivatives market status",
        )

    return _market_status_result(status.strip().upper())


def _normalize_expiries(value: object) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    expiries = []
    for item in value:
        if not isinstance(item, dict):
            continue
        date = item.get("date")
        timestamp = item.get("expiry")
        expiry_type = item.get("expiry_flag")
        if (
            isinstance(date, str)
            and isinstance(timestamp, (str, int))
            and re.fullmatch(r"\d{8,12}", str(timestamp))
        ):
            expiries.append(
                {
                    "date": date,
                    "timestamp": str(timestamp),
                    "type": (
                        expiry_type
                        if isinstance(expiry_type, str) and expiry_type in {"W", "M"}
                        else ""
                    ),
                }
            )
    return sorted(expiries, key=lambda expiry: int(expiry["timestamp"]))


def _normalize_option_chain(data: dict) -> dict:
    spot: dict | None = None
    options = []
    seen_contracts: set[tuple[float, str]] = set()
    raw_options = data.get("optionsChain")
    if isinstance(raw_options, list):
        for item in raw_options:
            if not isinstance(item, dict):
                continue
            option_type = item.get("option_type")
            if option_type == "":
                spot = item
                continue
            if not isinstance(option_type, str) or option_type not in {"CE", "PE"}:
                continue
            contract_symbol = item.get("symbol")
            strike = _number(item.get("strike_price"))
            if (
                not isinstance(contract_symbol, str)
                or not contract_symbol
                or strike is None
            ):
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "FYERS returned an option contract without a valid "
                        "symbol and strike"
                    ),
                )
            strike_suffix = f"{strike:g}{option_type}"
            if not contract_symbol.upper().endswith(strike_suffix):
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"FYERS contract {contract_symbol} does not match "
                        f"its reported {option_type} strike {strike:g}"
                    ),
                )
            contract_key = (strike, option_type)
            if contract_key in seen_contracts:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"FYERS returned more than one {option_type} contract "
                        f"for strike {strike:g}"
                    ),
                )
            seen_contracts.add(contract_key)
            greeks = item.get("greeks")
            options.append(
                {
                    "symbol": contract_symbol,
                    "type": option_type,
                    "strike": strike,
                    "ltp": _number(item.get("ltp")),
                    "change": _number(item.get("ltpch")),
                    "change_percent": _number(item.get("ltpchp")),
                    "volume": _number(item.get("volume")),
                    "oi": _number(item.get("oi")),
                    "oi_change": _number(item.get("oich")),
                    "bid": _number(item.get("bid")),
                    "ask": _number(item.get("ask")),
                    "greeks": {
                        key: _number(greeks.get(key))
                        for key in ("delta", "gamma", "theta", "vega", "iv")
                    }
                    if isinstance(greeks, dict)
                    else None,
                }
            )
    india_vix = data.get("indiavixData")
    if not isinstance(india_vix, dict):
        india_vix = None
    return {
        "spot": _number(spot.get("ltp")) if spot else None,
        "spot_change": _number(spot.get("ltpch")) if spot else None,
        "spot_change_percent": _number(spot.get("ltpchp")) if spot else None,
        "call_oi": _number(data.get("callOi")),
        "put_oi": _number(data.get("putOi")),
        "india_vix": (
            {
                "ltp": _number(india_vix.get("ltp")),
                "change": _number(india_vix.get("ltpch")),
                "change_percent": _number(india_vix.get("ltpchp")),
            }
            if india_vix
            else None
        ),
        "options": options,
    }


def _apply_cached_quotes(symbol: str, snapshot: dict) -> dict:
    result = copy.deepcopy(snapshot)
    spot_quote = _shared_market_feed.latest_quote(symbol)
    if spot_quote is not None:
        spot_price = _number(spot_quote.get("ltp"))
        if spot_price is not None and spot_price > 0:
            result["spot"] = spot_price
        for source, target in (
            ("ch", "spot_change"),
            ("chp", "spot_change_percent"),
        ):
            quote_value = _number(spot_quote.get(source))
            if quote_value is not None:
                result[target] = quote_value

    options = result.get("options")
    if not isinstance(options, list):
        return result
    for option in options:
        if not isinstance(option, dict) or not isinstance(option.get("symbol"), str):
            continue
        quote = _shared_market_feed.latest_quote(option["symbol"])
        if quote is None:
            continue
        price = _number(quote.get("ltp"))
        if price is not None and price > 0:
            option["ltp"] = price
        for source, target in (
            ("ch", "change"),
            ("chp", "change_percent"),
            ("vol_traded_today", "volume"),
            ("OI", "oi"),
            ("bid_price", "bid"),
            ("ask_price", "ask"),
        ):
            quote_value = _number(quote.get(source))
            if quote_value is not None:
                option[target] = quote_value
    return result


def _apply_option_chain_quotes(symbol: str, snapshot: dict) -> dict:
    expiries = snapshot.get("expiries")
    selected_expiry = snapshot.get("selected_expiry")
    if (
        symbol == "NSE:NIFTY50-INDEX"
        and isinstance(expiries, list)
        and expiries
        and isinstance(expiries[0], dict)
        and expiries[0].get("timestamp") == selected_expiry
    ):
        return copy.deepcopy(snapshot)
    return _apply_cached_quotes(symbol, snapshot)


@router.get("/login")
def login_start(
    user: User = Depends(admin_user), db: Session = Depends(get_db)
) -> RedirectResponse:
    _provider_configured()
    settings = get_settings()
    raw_state = secrets.token_urlsafe(32)
    db.add(
        FyersOAuthState(
            state_hash=_hash_state(raw_state),
            user_id=user.id,
            expires_at=datetime.now(UTC)
            + timedelta(minutes=settings.fyers_oauth_state_expire_minutes),
        )
    )
    db.commit()
    query = urlencode(
        {
            "client_id": settings.fyers_client_id,
            "redirect_uri": settings.fyers_redirect_uri,
            "response_type": "code",
            "state": raw_state,
        }
    )
    return RedirectResponse(
        f"{settings.fyers_api_base_url.rstrip('/')}/api/v3/generate-authcode?{query}",
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    )


@router.get("/callback")
def callback(
    code: str | None = Query(default=None, alias="auth_code"),
    state: str = Query(min_length=20),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    """Consume the provider callback, then redirect without credentials in the URL."""

    _provider_configured()
    now = datetime.now(UTC)
    record = db.scalar(
        select(FyersOAuthState).where(FyersOAuthState.state_hash == _hash_state(state))
    )
    if (
        record is None
        or record.used_at is not None
        or record.expires_at.replace(tzinfo=UTC) <= now
    ):
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")
    record.used_at = now
    db.commit()
    if not code:
        raise HTTPException(
            status_code=400, detail="FYERS authorization code is missing"
        )

    settings = get_settings()
    app_hash = app_id_hash(settings.fyers_client_id, settings.fyers_client_secret)
    payload = {
        "grant_type": "authorization_code",
        "appIdHash": app_hash,
        "code": code,
    }
    try:
        _ensure_fyers_api_available()
        _record_fyers_api_request()
        response = httpx.post(
            f"{settings.fyers_api_base_url.rstrip('/')}/api/v3/validate-authcode",
            json=payload,
            timeout=15,
        )
        response.raise_for_status()
        provider_payload = response.json()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 429:
            _raise_fyers_rate_limit(error, "authorization exchange")
        detail = (
            "FYERS rejected the authorization exchange "
            f"(HTTP {error.response.status_code})"
        )
        try:
            error_payload = error.response.json()
        except ValueError:
            error_payload = None
        if isinstance(error_payload, dict):
            provider_code = error_payload.get("code")
            provider_message = error_payload.get("message") or error_payload.get(
                "error"
            )
            if isinstance(provider_code, (int, str)) and not isinstance(
                provider_code, bool
            ):
                safe_code = str(provider_code)
                for sensitive_value in (
                    code,
                    settings.fyers_client_secret,
                    app_hash,
                ):
                    safe_code = safe_code.replace(sensitive_value, "[redacted]")
                detail += f"; provider code: {safe_code[:64]}"
            if isinstance(provider_message, str) and provider_message.strip():
                safe_message = provider_message.strip()
                for sensitive_value in (
                    code,
                    settings.fyers_client_secret,
                    app_hash,
                ):
                    safe_message = safe_message.replace(
                        sensitive_value, "[redacted]"
                    )
                detail += f"; provider message: {safe_message[:200]}"
        raise HTTPException(
            status_code=502, detail=detail
        ) from error
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="Unable to reach FYERS authorization service",
        ) from error
    except ValueError as error:
        raise HTTPException(
            status_code=502,
            detail="FYERS returned invalid JSON during authorization exchange",
        ) from error
    if not isinstance(provider_payload, dict):
        raise HTTPException(
            status_code=502,
            detail="FYERS returned an invalid authorization response",
        )
    access_token = provider_payload.get("access_token")
    refresh_token = provider_payload.get("refresh_token")
    if not isinstance(access_token, str) or not access_token:
        raise HTTPException(
            status_code=502, detail="FYERS did not return an access token"
        )
    cipher = _cipher()
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        connection = BrokerConnection(
            provider="fyers",
            encrypted_access_token=cipher.encrypt(access_token.encode()).decode(),
            encrypted_refresh_token=(
                cipher.encrypt(refresh_token.encode()).decode()
                if isinstance(refresh_token, str) and refresh_token
                else None
            ),
            connected_by_user_id=record.user_id,
        )
        db.add(connection)
    else:
        connection.encrypted_access_token = cipher.encrypt(
            access_token.encode()
        ).decode()
        connection.encrypted_refresh_token = (
            cipher.encrypt(refresh_token.encode()).decode()
            if isinstance(refresh_token, str) and refresh_token
            else None
        )
        connection.updated_at = now
    db.commit()
    return RedirectResponse(settings.frontend_origin.rstrip("/") + "/?fyers=connected")


@router.get("/status", response_model=FyersStatus)
def fyers_status(
    user: User = Depends(market_data_user), db: Session = Depends(get_db)
) -> FyersStatus:
    del user
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    return FyersStatus(
        connected=connection is not None,
        provider="fyers",
        connected_at=connection.updated_at if connection else None,
    )


@router.get("/market-status")
def fyers_option_market_status(
    user: User = Depends(password_updated_user), db: Session = Depends(get_db)
) -> dict[str, str]:
    del user
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="FYERS is not connected")

    access_token = _get_access_token(connection, db)
    return _fyers_option_market_status(access_token, db)


@router.get("/feed-settings")
def fyers_feed_settings(
    user: User = Depends(market_data_user), db: Session = Depends(get_db)
) -> dict[str, int]:
    del user
    settings = db.get(FyersFeedSettings, 1)
    return {
        "refresh_interval_seconds": (
            settings.refresh_interval_seconds if settings is not None else 5
        )
    }


@router.put("/feed-settings")
def update_fyers_feed_settings(
    update: FyersFeedSettingsUpdate,
    user: User = Depends(admin_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    global _feed_refresh_interval_seconds
    del user
    settings = db.get(FyersFeedSettings, 1)
    if settings is None:
        settings = FyersFeedSettings(
            id=1, refresh_interval_seconds=update.refresh_interval_seconds
        )
        db.add(settings)
    else:
        settings.refresh_interval_seconds = update.refresh_interval_seconds
    db.commit()
    _feed_refresh_interval_seconds = update.refresh_interval_seconds
    return {"refresh_interval_seconds": settings.refresh_interval_seconds}


@router.get("/api-usage")
def fyers_api_usage(
    user: User = Depends(admin_user), db: Session = Depends(get_db)
) -> dict[str, int | str]:
    del user
    today = datetime.now(_FYERS_TIMEZONE).date()
    settings = db.get(FyersFeedSettings, 1)
    if settings is None:
        raise HTTPException(
            status_code=503, detail="Fyers feed settings are not initialized."
        )
    used = (
        settings.api_requests_today
        if settings.api_requests_date == today
        else 0
    )
    return {
        "date": today.isoformat(),
        "daily_limit": _FYERS_DAILY_API_LIMIT,
        "requests_used": used,
        "requests_remaining": max(0, _FYERS_DAILY_API_LIMIT - used),
    }


@router.get("/profile")
def fyers_profile(
    user: User = Depends(admin_user), db: Session = Depends(get_db)
) -> object:
    """Fetch the connected FYERS profile without exposing its access token."""

    del user
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="FYERS is not connected")

    access_token = _get_access_token(connection, db)

    settings = get_settings()
    try:
        _ensure_fyers_api_available()
        _record_fyers_api_request()
        response = httpx.get(
            f"{settings.fyers_api_base_url.rstrip('/')}/api/v3/profile",
            headers={
                "Authorization": f"{settings.fyers_client_id}:{access_token}"
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 429:
            _raise_fyers_rate_limit(error, "profile")
        raise HTTPException(
            status_code=502, detail="FYERS profile request failed"
        ) from error
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(
            status_code=502, detail="FYERS profile request failed"
        ) from error
    if not isinstance(payload, dict) or (
        "s" in payload
        and (not isinstance(payload["s"], str) or payload["s"].lower() != "ok")
    ):
        raise HTTPException(status_code=502, detail="FYERS profile verification failed")
    return _without_tokens(payload, access_token)


def _fyers_expired_data(
    endpoint: str, params: dict[str, str], access_token: str
) -> dict:
    key = (endpoint, tuple(sorted(params.items())))
    with _expired_response_lock:
        now = time.monotonic()
        expired = [
            cache_key
            for cache_key, (cached_at, _) in _expired_response_cache.items()
            if now - cached_at >= _EXPIRED_RESPONSE_CACHE_TTL
        ]
        for cache_key in expired:
            del _expired_response_cache[cache_key]
        cached = _expired_response_cache.get(key)
        if cached is not None:
            _expired_response_cache.move_to_end(key)
            return copy.deepcopy(cached[1])
        payload = _fetch_fyers_expired_data(endpoint, params, access_token)
        _expired_response_cache[key] = (time.monotonic(), copy.deepcopy(payload))
        while len(_expired_response_cache) > 512:
            _expired_response_cache.popitem(last=False)
        return payload


def _fetch_fyers_expired_data(
    endpoint: str, params: dict[str, str], access_token: str
) -> dict:
    _ensure_fyers_api_available()
    settings = get_settings()
    try:
        _record_fyers_api_request()
        response = httpx.get(
            f"{settings.fyers_api_base_url.rstrip('/')}/data/history/fno/expired/{endpoint}",
            params=params,
            headers={"Authorization": f"{settings.fyers_client_id}:{access_token}"},
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 429:
            _raise_fyers_rate_limit(error, f"expired endpoint {endpoint}")
        response = error.response
        provider_message = ""
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            for key in ("message", "detail", "error"):
                value = body.get(key)
                if isinstance(value, str) and value.strip():
                    provider_message = value.strip()[:240]
                    break
        logger.warning(
            "FYERS expired endpoint %s returned HTTP %s",
            endpoint,
            response.status_code,
        )
        message = f"Expired market-data service returned HTTP {response.status_code}"
        if provider_message:
            message = f"{message}: {provider_message}"
        raise HTTPException(status_code=502, detail=message) from error
    except httpx.RequestError as error:
        logger.exception("FYERS expired endpoint %s request failed", endpoint)
        raise HTTPException(
            status_code=502,
            detail="Unable to reach the expired market-data service",
        ) from error
    except ValueError as error:
        logger.exception("FYERS expired endpoint %s returned invalid JSON", endpoint)
        raise HTTPException(
            status_code=502,
            detail="Expired market-data service returned invalid JSON",
        ) from error
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502, detail="FYERS returned an invalid expired-data response"
        )
    return payload


def _cached_expired_contracts(
    underlying_symbol: str, expiry_date: str
) -> set[str] | None:
    key = (underlying_symbol, expiry_date)
    now = time.monotonic()
    with _expired_contract_catalog_lock:
        expired = [
            item_key
            for item_key, (cached_at, _) in _expired_contract_catalog_cache.items()
            if now - cached_at >= _EXPIRED_CONTRACT_CATALOG_TTL
        ]
        for item_key in expired:
            del _expired_contract_catalog_cache[item_key]
        cached = _expired_contract_catalog_cache.get(key)
        return set(cached[1]) if cached else None


def _cache_expired_contracts(
    underlying_symbol: str, expiry_date: str, symbols: set[str]
) -> None:
    key = (underlying_symbol, expiry_date)
    with _expired_contract_catalog_lock:
        _expired_contract_catalog_cache[key] = (time.monotonic(), set(symbols))
        while len(_expired_contract_catalog_cache) > 256:
            oldest = min(
                _expired_contract_catalog_cache,
                key=lambda item: _expired_contract_catalog_cache[item][0],
            )
            del _expired_contract_catalog_cache[oldest]


def _expired_response_data(payload: dict) -> dict:
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=502, detail="FYERS returned an invalid expired-data response"
        )
    return data


def _validated_date(value: str, field: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(
            status_code=422, detail=f"{field} must use yyyy-mm-dd format"
        ) from error
    if parsed.isoformat() != value:
        raise HTTPException(
            status_code=422, detail=f"{field} must use yyyy-mm-dd format"
        )
    return parsed


def _expired_symbols(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    symbols = []
    for item in value:
        symbol = item.get("symbol") if isinstance(item, dict) else item
        if (
            isinstance(symbol, str)
            and len(symbol) <= 40
            and re.fullmatch(r"(?:NSE|BSE|MCX):[A-Za-z0-9&_-]+", symbol)
        ):
            symbols.append(symbol)
    return sorted(set(symbols))


def _expired_dates(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    dates = set()
    for item in value:
        candidate = item.get("date") if isinstance(item, dict) else item
        if not isinstance(candidate, str):
            continue
        parsed = None
        for date_format in ("%Y-%m-%d", "%d-%m-%Y"):
            try:
                parsed = datetime.strptime(candidate, date_format).date()
                break
            except ValueError:
                continue
        if parsed is not None:
            dates.add(parsed.isoformat())
    return sorted(dates)


def _expired_expiry_date_ranges(start: date, end: date) -> list[tuple[date, date]]:
    ranges = []
    current = start
    while current <= end:
        next_month = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
        range_end = min(end, next_month - timedelta(days=1))
        ranges.append((current, range_end))
        current = range_end + timedelta(days=1)
    return ranges


def _is_expired_input_rejection(payload: dict) -> bool:
    message = payload.get("message")
    return (
        payload.get("s") != "ok"
        and isinstance(message, str)
        and "invalid input" in message.lower()
    )


def _is_expired_http_422(error: HTTPException) -> bool:
    return (
        error.status_code == 502
        and "returned HTTP 422: Invalid input" in str(error.detail)
    )


def _normalize_expired_candles(
    payload: dict, symbol: str, resolution: str, include_oi: bool
) -> dict:
    if payload.get("s") == "no_data":
        return {
            "symbol": symbol,
            "resolution": resolution,
            "candles": [],
            "error": None,
        }
    if payload.get("s") != "ok":
        return {
            "symbol": symbol,
            "resolution": resolution,
            "candles": [],
            "error": "Historical data is unavailable for this contract.",
        }
    raw_candles = payload.get("candles")
    columns = payload.get("columns")
    if not isinstance(raw_candles, list) or not isinstance(columns, list):
        return {
            "symbol": symbol,
            "resolution": resolution,
            "candles": [],
            "error": "Provider returned invalid historical candles.",
        }
    has_oi = include_oi and "open_interest" in columns
    candles_by_time = {}
    for candle in raw_candles:
        if not isinstance(candle, list) or len(candle) < 6:
            continue
        timestamp, open_price, high, low, close, volume = (
            _number(value) for value in candle[:6]
        )
        if (
            timestamp is None
            or timestamp <= 0
            or not timestamp.is_integer()
            or open_price is None
            or high is None
            or low is None
            or close is None
            or volume is None
            or volume < 0
            or high < max(open_price, close, low)
            or low > min(open_price, close, high)
        ):
            continue
        item = {
            "time": int(timestamp),
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
        if has_oi and len(candle) > 6:
            open_interest = _number(candle[6])
            if open_interest is not None:
                item["open_interest"] = open_interest
        candles_by_time[item["time"]] = item
    candles = [candles_by_time[timestamp] for timestamp in sorted(candles_by_time)]
    return {
        "symbol": symbol,
        "resolution": resolution,
        "candles": candles,
        "error": None,
    }


@router.get("/option-chain/symbols")
def option_chain_symbols(user: User = Depends(market_data_user)) -> dict:
    del user
    return {"symbols": FYERS_OPTION_UNDERLYINGS}


def _fyers_option_lot_sizes(exchange: str) -> dict[str, int]:
    now = time.monotonic()
    with _option_lot_size_lock:
        cached = _option_lot_size_cache.get(exchange)
        if cached is not None and cached[0] > now:
            return cached[1]
        try:
            response = httpx.get(
                _FYERS_FO_SYMBOL_MASTER_URL.format(exchange=exchange),
                timeout=20,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            logger.exception("Unable to load the %s F&O symbol master", exchange)
            raise HTTPException(
                status_code=502,
                detail="Unable to load contract lot sizes from the instrument master.",
            ) from error
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=502,
                detail="The instrument master returned an invalid lot-size catalog.",
            )
        lot_sizes: dict[str, int] = {}
        for symbol, contract in payload.items():
            if not isinstance(symbol, str) or not isinstance(contract, dict):
                continue
            lot_size = _number(contract.get("minLotSize"))
            if lot_size is not None and lot_size > 0 and lot_size.is_integer():
                lot_sizes[symbol] = int(lot_size)
        _option_lot_size_cache[exchange] = (
            now + _OPTION_LOT_SIZE_CACHE_TTL,
            lot_sizes,
        )
        return lot_sizes


@router.post("/option-chain/lot-sizes")
def option_chain_lot_sizes(
    symbols: list[str] = Body(),
    user: User = Depends(market_data_user),
) -> dict:
    del user
    if not symbols or len(symbols) > 300:
        raise HTTPException(
            status_code=422, detail="Select between 1 and 300 option contracts"
        )
    if len(set(symbols)) != len(symbols):
        raise HTTPException(status_code=422, detail="Duplicate option contract symbols")
    exchanges: set[str] = set()
    for symbol in symbols:
        match = re.fullmatch(r"(NSE|BSE):[A-Za-z0-9&_-]+(?:CE|PE)", symbol)
        if match is None:
            raise HTTPException(
                status_code=422, detail="Invalid option contract symbol"
            )
        exchanges.add(match.group(1))
    master_lot_sizes = {
        exchange: _fyers_option_lot_sizes(exchange) for exchange in exchanges
    }
    return {
        "lot_sizes": {
            symbol: master_lot_sizes[symbol.split(":", maxsplit=1)[0]].get(symbol)
            for symbol in symbols
        }
    }


def _feed_interval(db: Session) -> int:
    global _feed_refresh_interval_seconds
    settings = db.get(FyersFeedSettings, 1)
    if settings is not None:
        _feed_refresh_interval_seconds = min(
            5, max(1, settings.refresh_interval_seconds)
        )
    return _feed_refresh_interval_seconds


def _default_chain_payload(market_status: str | None = None) -> dict | None:
    with _default_chain_state_lock:
        if _default_chain_snapshot is None:
            return None
        result = copy.deepcopy(_default_chain_snapshot)
        updated_at = _default_chain_updated_at
        error = _default_chain_error

    interval = _feed_refresh_interval_seconds
    age = (
        max(0.0, (datetime.now(UTC) - updated_at).total_seconds())
        if updated_at is not None
        else float("inf")
    )
    effective_market_status = market_status or "UNKNOWN"
    if effective_market_status != "OPEN":
        data_status = (
            "closed" if effective_market_status != "UNKNOWN" else "unavailable"
        )
    elif age <= interval * 2:
        data_status = "live"
    else:
        data_status = "stale"
    if error and effective_market_status == "OPEN":
        data_status = "stale"
    result["data_status"] = data_status
    result["market_status"] = effective_market_status
    result["last_updated_at"] = updated_at.isoformat() if updated_at else None
    result["data_error"] = error
    return result


def _refresh_default_chain_once(db: Session) -> str:
    global _default_chain_snapshot, _default_chain_updated_at, _default_chain_error
    with _default_chain_refresh_lock:
        connection = db.scalar(
            select(BrokerConnection).where(BrokerConnection.provider == "fyers")
        )
        if connection is None:
            with _default_chain_state_lock:
                _default_chain_error = "The market-data account is not connected."
            return "UNAVAILABLE"

        try:
            access_token = _get_access_token(connection, db)
            market_status = _fyers_option_market_status(access_token, db)["status"]
            if market_status != "OPEN":
                with _default_chain_state_lock:
                    _default_chain_error = None
                return market_status

            symbol = "NSE:NIFTY50-INDEX"
            chain_data = _fyers_data(
                "options-chain-v3",
                {"symbol": symbol, "strikecount": "50", "greeks": "1"},
                access_token,
            )
            expiries = _normalize_expiries(chain_data.get("expiryData"))
            selected_expiry = expiries[0]["timestamp"] if expiries else None
            response = {
                "symbol": symbol,
                "expiries": expiries,
                "selected_expiry": selected_expiry,
                **_normalize_option_chain(chain_data),
            }
            if selected_expiry is None:
                raise HTTPException(
                    status_code=502,
                    detail="The provider returned no current NIFTY expiry.",
                )
            _shared_market_feed.cache_option_contracts(
                symbol, selected_expiry, chain_data
            )
            now = datetime.now(UTC)
            response["data_status"] = "live"
            response["market_status"] = market_status
            response["last_updated_at"] = now.isoformat()
            response["data_error"] = None
            with _default_chain_state_lock:
                _default_chain_snapshot = copy.deepcopy(response)
                _default_chain_updated_at = now
                _default_chain_error = None
            _shared_market_feed.cache_chain_snapshot(symbol, selected_expiry, response)
            return market_status
        except HTTPException as error:
            with _default_chain_state_lock:
                _default_chain_error = str(error.detail)
            raise


def _fyers_feed_poller() -> None:
    failure_count = 0
    while not _feed_poller_stop.is_set():
        interval = 5
        refresh_started_at = time.monotonic()
        try:
            with SessionLocal() as db:
                interval = _feed_interval(db)
                _refresh_default_chain_once(db)
        except HTTPException as error:
            failure_count += 1
            retry_after = error.headers.get("Retry-After") if error.headers else None
            try:
                delay = (
                    max(interval, int(retry_after))
                    if retry_after
                    else min(300, interval * 2 ** min(failure_count, 6))
                )
            except ValueError:
                delay = min(300, interval * 2 ** min(failure_count, 6))
            logger.warning("Shared NIFTY chain refresh paused: %s", error.detail)
        except Exception:
            failure_count += 1
            delay = min(300, interval * 2 ** min(failure_count, 6))
            logger.exception("Shared NIFTY chain refresh failed")
        else:
            failure_count = 0
            delay = max(
                0.0, interval - (time.monotonic() - refresh_started_at)
            )
        _feed_poller_stop.wait(delay)


def start_fyers_feed_poller() -> None:
    global _feed_poller_thread
    if _feed_poller_thread is not None and _feed_poller_thread.is_alive():
        return
    _feed_poller_stop.clear()
    _feed_poller_thread = threading.Thread(
        target=_fyers_feed_poller, name="fyers-nifty-chain-poller", daemon=True
    )
    _feed_poller_thread.start()


def stop_fyers_feed_poller() -> None:
    global _feed_poller_thread
    _feed_poller_stop.set()
    if _feed_poller_thread is not None:
        _feed_poller_thread.join(timeout=2)
        _feed_poller_thread = None


@router.get("/option-chain")
def fyers_option_chain(
    symbol: str = Query(min_length=5, max_length=40),
    timestamp: str | None = Query(default=None, pattern=r"^\d{8,12}$"),
    user: User = Depends(market_data_user),
    db: Session = Depends(get_db),
) -> dict:
    del user
    if symbol not in {item["symbol"] for item in FYERS_OPTION_UNDERLYINGS}:
        raise HTTPException(
            status_code=422, detail="Unsupported FYERS underlying symbol"
        )
    cached_snapshot = _shared_market_feed.cached_chain_snapshot(symbol, timestamp)
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="FYERS is not connected")

    try:
        access_token = _get_access_token(connection, db)
        market_status = _fyers_option_market_status(access_token, db)["status"]
        is_nifty = symbol == "NSE:NIFTY50-INDEX"
        default_snapshot = (
            _default_chain_payload(market_status) if is_nifty else None
        )
        if default_snapshot is not None and (
            timestamp is None or timestamp == default_snapshot["selected_expiry"]
        ):
            return _apply_option_chain_quotes(symbol, default_snapshot)

        if market_status != "OPEN":
            if cached_snapshot is not None:
                cached_snapshot["data_status"] = "closed"
                cached_snapshot["market_status"] = market_status
                cached_snapshot["data_error"] = None
                return _apply_option_chain_quotes(symbol, cached_snapshot)
            raise HTTPException(
                status_code=503,
                detail="Market is closed; no fresh option-chain data is available.",
            )

        if is_nifty and timestamp is None:
            _refresh_default_chain_once(db)
            default_snapshot = _default_chain_payload(market_status)
            if default_snapshot is not None:
                return _apply_option_chain_quotes(symbol, default_snapshot)

        discovery_data = _fyers_data(
            "options-chain-v3",
            {
                "symbol": symbol,
                "strikecount": "1" if timestamp is not None else "50",
                "greeks": "1",
            },
            access_token,
        )
        expiries = _normalize_expiries(discovery_data.get("expiryData"))
        selected_expiry = timestamp
        chain_data = discovery_data
        if timestamp is not None:
            if timestamp not in {expiry["timestamp"] for expiry in expiries}:
                raise HTTPException(
                    status_code=422, detail="Invalid expiry for FYERS symbol"
                )
            chain_data = _fyers_data(
                "options-chain-v3",
                {
                    "symbol": symbol,
                    "strikecount": "50",
                    "timestamp": timestamp,
                    "greeks": "1",
                },
                access_token,
            )
        else:
            selected_expiry = expiries[0]["timestamp"] if expiries else None

        response = {
            "symbol": symbol,
            "expiries": expiries,
            "selected_expiry": selected_expiry,
            **_normalize_option_chain(chain_data),
        }
        response["data_status"] = "live"
        response["market_status"] = market_status
        response["last_updated_at"] = datetime.now(UTC).isoformat()
        response["data_error"] = None
        if selected_expiry is not None:
            _shared_market_feed.cache_option_contracts(
                symbol, selected_expiry, chain_data
            )
            _shared_market_feed.cache_chain_snapshot(
                symbol, selected_expiry, response
            )
        return _apply_option_chain_quotes(symbol, response)
    except HTTPException as error:
        if error.status_code in {502, 503, 504} and cached_snapshot is not None:
            logger.warning(
                "Serving stale option-chain snapshot for %s after provider failure: %s",
                symbol, error.detail
            )
            cached_snapshot["data_status"] = "stale"
            cached_snapshot["data_error"] = str(error.detail)
            return _apply_option_chain_quotes(symbol, cached_snapshot)
        raise


@router.post("/stream-ticket")
def fyers_stream_ticket(user: User = Depends(market_data_user)) -> dict[str, str]:
    """Issue a short-lived token for the authenticated market WebSocket."""

    settings = get_settings()
    now = datetime.now(UTC)
    return {
        "ticket": jwt.encode(
            {
                "sub": str(user.id),
                "type": "market_stream",
                "iat": now,
                "exp": now + timedelta(seconds=60),
            },
            settings.secret_key,
            algorithm=settings.jwt_algorithm,
        )
    }


@router.websocket("/stream")
async def fyers_market_stream(
    websocket: WebSocket, db: Session = Depends(get_db)
) -> None:
    """Relay authorized FYERS symbol updates without exposing provider credentials."""

    await websocket.accept()

    event_task: asyncio.Task | None = None
    client_task: asyncio.Task | None = None
    subscriber_id: str | None = None
    try:
        initial = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(initial, dict):
            await websocket.close(code=4400, reason="Invalid stream request")
            return

        ticket = initial.get("ticket")
        settings = get_settings()
        try:
            claims = jwt.decode(
                ticket,
                settings.secret_key,
                algorithms=[settings.jwt_algorithm],
            )
            if claims.get("type") != "market_stream":
                raise jwt.InvalidTokenError("Invalid stream ticket")
            user_id = int(claims["sub"])
        except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
            await websocket.close(code=4401, reason="Authentication required")
            return

        user = db.get(User, user_id)
        if user is None or not user.is_active:
            await websocket.close(code=4401, reason="Authentication required")
            return
        if not has_market_access(user):
            await websocket.close(
                code=4403, reason="License activation is pending"
            )
            return
        connection = db.scalar(
            select(BrokerConnection).where(BrokerConnection.provider == "fyers")
        )
        if connection is None:
            await websocket.close(
                code=4404, reason="Market account is not connected"
            )
            return
        access_token = _get_access_token(connection, db)

        symbol = initial.get("symbol")
        timestamp = initial.get("timestamp")
        requested_symbols = initial.get("symbols")
        if (
            not isinstance(symbol, str)
            or symbol not in {item["symbol"] for item in FYERS_OPTION_UNDERLYINGS}
            or not isinstance(timestamp, str)
            or not re.fullmatch(r"\d{8,12}", timestamp)
            or not isinstance(requested_symbols, list)
            or len(requested_symbols) > 200
            or any(not isinstance(item, str) for item in requested_symbols)
        ):
            await websocket.close(code=4400, reason="Invalid stream subscription")
            return

        allowed_symbols = _shared_market_feed.cached_option_contracts(
            symbol, timestamp
        )
        if allowed_symbols is None:
            discovery = _fyers_data(
                "options-chain-v3",
                {"symbol": symbol, "strikecount": "1", "greeks": "1"},
                access_token,
            )
            expiries = _normalize_expiries(discovery.get("expiryData"))
            if timestamp not in {item["timestamp"] for item in expiries}:
                await websocket.close(code=4400, reason="Invalid market expiry")
                return
            chain_data = _fyers_data(
                "options-chain-v3",
                {
                    "symbol": symbol,
                    "strikecount": "50",
                    "timestamp": timestamp,
                    "greeks": "1",
                },
                access_token,
            )
            _normalize_option_chain(chain_data)
            _shared_market_feed.cache_option_contracts(
                symbol, timestamp, chain_data
            )
            allowed_symbols = _shared_market_feed.cached_option_contracts(
                symbol, timestamp
            )
            if allowed_symbols is None:
                await websocket.close(
                    code=4400, reason="No option contracts available for expiry"
                )
                return
        allowed_symbols.add(symbol)
        active_symbols = set(requested_symbols)
        if (
            symbol not in active_symbols
            or not active_symbols.issubset(allowed_symbols)
            or len(active_symbols) > 200
        ):
            await websocket.close(code=4400, reason="Invalid stream symbols")
            return

        loop = asyncio.get_running_loop()
        events: asyncio.Queue[dict] = asyncio.Queue(maxsize=1000)
        subscriber_id = secrets.token_urlsafe(18)
        await asyncio.to_thread(
            _shared_market_feed.add_subscriber,
            subscriber_id,
            loop,
            events,
            active_symbols,
            access_token,
        )
        await websocket.send_json({"type": "status", "status": "connecting"})

        event_task = asyncio.create_task(events.get())
        client_task = asyncio.create_task(websocket.receive_json())
        while True:
            done, _pending = await asyncio.wait(
                {event_task, client_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if event_task in done:
                event = event_task.result()
                event_task = asyncio.create_task(events.get())
                if event["type"] != "provider":
                    await websocket.send_json(event)
                    continue

                message = event["message"]
                updated_symbol = message.get("symbol")
                price = _number(message.get("ltp"))
                if (
                    not isinstance(updated_symbol, str)
                    or updated_symbol not in active_symbols
                    or price is None
                    or price <= 0
                ):
                    continue
                await websocket.send_json(
                    {
                        "type": "tick",
                        "symbol": updated_symbol,
                        "ltp": price,
                        "volume": _number(message.get("vol_traded_today")),
                        "oi": _number(message.get("OI") or message.get("oi")),
                        "bid": _number(message.get("bid_price")),
                        "ask": _number(message.get("ask_price")),
                        "time": _number(message.get("exch_feed_time"))
                        or _number(message.get("last_traded_time")),
                        "change": _number(message.get("ch")),
                        "change_percent": _number(message.get("chp")),
                    }
                )

            if client_task in done:
                request = client_task.result()
                client_task = asyncio.create_task(websocket.receive_json())
                if not isinstance(request, dict):
                    continue
                if request.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if request.get("type") != "subscribe":
                    continue
                next_symbols = request.get("symbols")
                if (
                    not isinstance(next_symbols, list)
                    or len(next_symbols) > 200
                    or any(not isinstance(item, str) for item in next_symbols)
                ):
                    await websocket.send_json(
                        {"type": "error", "message": "Invalid market subscription."}
                    )
                    continue
                next_active = set(next_symbols)
                if (
                    symbol not in next_active
                    or not next_active.issubset(allowed_symbols)
                    or len(next_active) > 200
                ):
                    await websocket.send_json(
                        {"type": "error", "message": "Unsupported market symbols."}
                    )
                    continue
                active_symbols = next_active
                await asyncio.to_thread(
                    _shared_market_feed.update_subscriber,
                    subscriber_id,
                    active_symbols,
                )
    except WebSocketDisconnect:
        return
    except TimeoutError:
        await websocket.close(code=4408, reason="Stream authentication timed out")
    except Exception:
        logger.exception("Market WebSocket session failed")
        try:
            await websocket.send_json(
                {"type": "error", "message": "Live market feed could not be started."}
            )
        except Exception:
            logger.debug(
                "Unable to report market stream failure to disconnected client"
            )
    finally:
        for task in (event_task, client_task):
            if task is not None and not task.done():
                task.cancel()
        pending_tasks = [
            task
            for task in (event_task, client_task)
            if task is not None
        ]
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)
        if subscriber_id is not None:
            await asyncio.to_thread(
                _shared_market_feed.remove_subscriber, subscriber_id
            )


def _fyers_history_data(params: dict[str, str], access_token: str) -> dict:
    key = tuple(sorted(params.items()))
    with _history_response_lock:
        now = time.monotonic()
        expired = [
            cache_key
            for cache_key, (cached_at, _) in _history_response_cache.items()
            if now - cached_at >= _HISTORY_RESPONSE_CACHE_TTL
        ]
        for cache_key in expired:
            del _history_response_cache[cache_key]
        cached = _history_response_cache.get(key)
        if cached is not None:
            _history_response_cache.move_to_end(key)
            return copy.deepcopy(cached[1])

        _ensure_fyers_api_available()
        settings = get_settings()
        try:
            _record_fyers_api_request()
            response = httpx.get(
                f"{settings.fyers_api_base_url.rstrip('/')}/data/history",
                params=params,
                headers={
                    "Authorization": f"{settings.fyers_client_id}:{access_token}"
                },
                timeout=20,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 429:
                _raise_fyers_rate_limit(error, "history")
            raise HTTPException(
                status_code=502, detail="Historical market-data request failed"
            ) from error
        except (httpx.HTTPError, ValueError) as error:
            raise HTTPException(
                status_code=502, detail="Historical market-data request failed"
            ) from error
        if not isinstance(payload, dict) or payload.get("s") != "ok":
            raise HTTPException(
                status_code=502, detail="Historical market-data request failed"
            )
        _history_response_cache[key] = (time.monotonic(), copy.deepcopy(payload))
        while len(_history_response_cache) > 256:
            _history_response_cache.popitem(last=False)
        return payload


@router.get("/history")
def fyers_history(
    symbol: str = Query(min_length=5, max_length=40),
    resolution: str = Query(
        default="5", pattern=r"^(1|2|3|5|10|15|20|30|45|60|120|180|240|D)$"
    ),
    range_from: str | None = Query(default=None),
    range_to: str | None = Query(default=None),
    user: User = Depends(market_data_user),
    db: Session = Depends(get_db),
) -> dict:
    """Return normalized spot candles for a supported underlying."""

    del user
    if symbol not in {item["symbol"] for item in FYERS_OPTION_UNDERLYINGS}:
        raise HTTPException(status_code=422, detail="Unsupported market symbol")
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="Market account is not connected")

    today = datetime.now(UTC).date()
    lookback_days = {
        "1": 5,
        "2": 5,
        "3": 5,
        "5": 30,
        "10": 30,
        "15": 30,
        "20": 30,
        "30": 60,
        "45": 100,
        "60": 100,
        "120": 100,
        "180": 100,
        "240": 100,
        "D": 365,
    }
    if (range_from is None) != (range_to is None):
        raise HTTPException(
            status_code=422, detail="Both range_from and range_to are required"
        )
    access_token = _get_access_token(connection, db)
    if range_from is None or range_to is None:
        selected_from = (today - timedelta(days=lookback_days[resolution])).isoformat()
        selected_to = today.isoformat()
    else:
        start = _validated_date(range_from, "range_from")
        end = _validated_date(range_to, "range_to")
        maximum_days = 365 if resolution == "D" else 99
        if end < start or end > today or (end - start).days > maximum_days:
            raise HTTPException(
                status_code=422,
                detail=(
                    "History range must be ordered and at most "
                    f"{maximum_days + 1} days"
                ),
            )
        selected_from = range_from
        selected_to = range_to
    payload = _fyers_history_data(
        {
            "symbol": symbol,
            "resolution": resolution,
            "date_format": "1",
            "range_from": selected_from,
            "range_to": selected_to,
            "cont_flag": "1",
        },
        access_token,
    )
    if not isinstance(payload, dict) or payload.get("s") != "ok":
        raise HTTPException(
            status_code=502, detail="Historical market-data request failed"
        )

    raw_candles = payload.get("candles")
    if not isinstance(raw_candles, list):
        raise HTTPException(
            status_code=502, detail="Market-data service returned invalid candles"
        )

    candles_by_time = {}
    for candle in raw_candles:
        if not isinstance(candle, list) or len(candle) < 6:
            continue
        timestamp = _number(candle[0])
        open_price, high, low, close, volume = (
            _number(value) for value in candle[1:6]
        )
        if (
            timestamp is None
            or timestamp <= 0
            or not timestamp.is_integer()
            or open_price is None
            or high is None
            or low is None
            or close is None
            or volume is None
            or volume < 0
            or high < max(open_price, close, low)
            or low > min(open_price, close, high)
        ):
            continue
        item = {
            "time": int(timestamp),
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
        candles_by_time[item["time"]] = item

    candles = [candles_by_time[timestamp] for timestamp in sorted(candles_by_time)]
    return {
        "symbol": symbol,
        "resolution": resolution,
        "candles": candles,
    }


@router.get("/expired/expiry-dates")
def fyers_expired_expiry_dates(
    symbol: str = Query(min_length=5, max_length=40),
    range_from: str = Query(),
    range_to: str = Query(),
    user: User = Depends(market_data_user),
    db: Session = Depends(get_db),
) -> dict:
    del user
    if symbol not in {item["symbol"] for item in FYERS_OPTION_UNDERLYINGS}:
        raise HTTPException(status_code=422, detail="Unsupported market symbol")
    start = _validated_date(range_from, "range_from")
    end = _validated_date(range_to, "range_to")
    if end < start or (end - start).days > 365:
        raise HTTPException(
            status_code=422, detail="Date range must be ordered and at most 366 days"
        )
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="Market account is not connected")

    access_token = _get_access_token(connection, db)
    base_params = {"symbol": symbol, "date_format": "1"}
    initial_error = None
    try:
        payload = _fyers_expired_data(
            "expiry-dates",
            {
                **base_params,
                "range_from": range_from,
                "range_to": range_to,
            },
            access_token,
        )
    except HTTPException as error:
        if not _is_expired_http_422(error):
            raise
        initial_error = error
        payload = {}

    rejected_ranges = 0
    if initial_error is not None or _is_expired_input_rejection(payload):
        def fetch_range(date_range: tuple[date, date]) -> tuple[dict | None, bool]:
            chunk_start, chunk_end = date_range
            try:
                chunk_payload = _fyers_expired_data(
                    "expiry-dates",
                    {
                        **base_params,
                        "range_from": chunk_start.isoformat(),
                        "range_to": chunk_end.isoformat(),
                    },
                    access_token,
                )
            except HTTPException as error:
                if _is_expired_http_422(error):
                    return None, True
                raise
            if _is_expired_input_rejection(chunk_payload):
                return None, True
            return chunk_payload, False

        ranges = _expired_expiry_date_ranges(start, end)
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(fetch_range, ranges))
        accepted_payloads = [item for item, rejected in results if item is not None]
        rejected_ranges = sum(rejected for _, rejected in results)
        invalid_payload = next(
            (item for item in accepted_payloads if item.get("s") != "ok"),
            None,
        )
        if invalid_payload is not None:
            provider_message = invalid_payload.get("message")
            detail = (
                f"Expired expiry lookup failed: {provider_message[:240]}"
                if isinstance(provider_message, str) and provider_message
                else "Expired expiry lookup failed"
            )
            raise HTTPException(status_code=502, detail=detail)
        if not accepted_payloads:
            if initial_error is not None:
                raise initial_error
            provider_message = payload.get("message")
            detail = (
                f"Expired expiry lookup failed: {provider_message[:240]}"
                if isinstance(provider_message, str) and provider_message
                else "Expired expiry lookup failed"
            )
            raise HTTPException(status_code=502, detail=detail)
        payload = {
            "s": "ok",
            "data": {
                "expiry_dates": {
                    kind: [
                        expiry
                        for item in accepted_payloads
                        for expiry in _expired_response_data(item)
                        .get("expiry_dates", {})
                        .get(kind, [])
                    ]
                    for kind in ("options", "futures")
                }
            },
        }

    if payload.get("s") != "ok":
        provider_message = payload.get("message")
        detail = (
            f"Expired expiry lookup failed: {provider_message[:240]}"
            if isinstance(provider_message, str) and provider_message
            else "Expired expiry lookup failed"
        )
        raise HTTPException(status_code=502, detail=detail)
    data = _expired_response_data(payload)
    expiry_dates = data.get("expiry_dates")
    if not isinstance(expiry_dates, dict):
        raise HTTPException(
            status_code=502, detail="FYERS returned invalid expiry dates"
        )
    response = {
        "symbol": symbol,
        "futures": _expired_dates(expiry_dates.get("futures")),
        "options": _expired_dates(expiry_dates.get("options")),
    }
    if rejected_ranges:
        response["warnings"] = [
            "FYERS rejected some date-range segments; only expiries from supported "
            "segments are listed."
        ]
    return response


@router.get("/expired/contracts")
def fyers_expired_contracts(
    symbol: str = Query(min_length=5, max_length=40),
    expiry_date: str = Query(),
    user: User = Depends(market_data_user),
    db: Session = Depends(get_db),
) -> dict:
    del user
    if symbol not in {item["symbol"] for item in FYERS_OPTION_UNDERLYINGS}:
        raise HTTPException(status_code=422, detail="Unsupported market symbol")
    selected_date = _validated_date(expiry_date, "expiry_date")
    if selected_date >= datetime.now(UTC).date():
        raise HTTPException(status_code=422, detail="Expiry date must be in the past")
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="Market account is not connected")

    payload = _fyers_expired_data(
        "underlying-symbols",
        {"symbol": symbol, "expiry_date": expiry_date},
        _get_access_token(connection, db),
    )
    if payload.get("s") != "ok":
        raise HTTPException(status_code=502, detail="Expired contract lookup failed")
    data = _expired_response_data(payload)
    contracts = data.get("contracts")
    if not isinstance(contracts, dict):
        raise HTTPException(
            status_code=502, detail="FYERS returned invalid expired contracts"
        )
    exchange = symbol.split(":", maxsplit=1)[0]
    futures = [
        item for item in _expired_symbols(contracts.get("futures"))
        if item.startswith(f"{exchange}:")
    ]
    options = [
        item for item in _expired_symbols(contracts.get("options"))
        if item.startswith(f"{exchange}:")
    ]
    _cache_expired_contracts(symbol, expiry_date, set(options))
    return {
        "symbol": symbol,
        "expiry_date": expiry_date,
        "futures": futures,
        "options": options,
    }


@router.get("/expired/history")
def fyers_expired_history(
    symbol: str = Query(min_length=7, max_length=40),
    resolution: str = Query(
        default="5", pattern=r"^(5S|1|2|3|5|10|15|20|30|45|60|120|180|240)$"
    ),
    range_from: str = Query(),
    range_to: str = Query(),
    include_oi: bool = Query(default=True),
    user: User = Depends(market_data_user),
    db: Session = Depends(get_db),
) -> dict:
    del user
    selected_symbol = re.fullmatch(r"(NSE|BSE|MCX):[A-Za-z0-9&_-]+", symbol)
    if selected_symbol is None:
        raise HTTPException(status_code=422, detail="Invalid expired contract symbol")
    start = _validated_date(range_from, "range_from")
    end = _validated_date(range_to, "range_to")
    if end < start or (end - start).days > 99:
        raise HTTPException(
            status_code=422,
            detail="Historical range must be ordered and at most 100 days",
        )
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="Market account is not connected")

    params = {
        "symbol": symbol,
        "resolution": resolution,
        "date_format": "1",
        "range_from": range_from,
        "range_to": range_to,
    }
    if include_oi:
        params["include_oi"] = "1"
    payload = _fyers_expired_data(
        "historical-data", params, _get_access_token(connection, db)
    )
    result = _normalize_expired_candles(payload, symbol, resolution, include_oi)
    if result["error"]:
        raise HTTPException(status_code=502, detail=result["error"])
    return result


@router.post("/expired/chain-history")
def fyers_expired_chain_history(
    underlying_symbol: str = Query(min_length=5, max_length=40),
    expiry_date: str = Query(),
    symbols: list[str] = Body(),
    resolution: str = Query(
        default="5", pattern=r"^(5S|1|2|3|5|10|15|20|30|45|60|120|180|240)$"
    ),
    range_from: str = Query(),
    range_to: str = Query(),
    include_oi: bool = Query(default=True),
    user: User = Depends(market_data_user),
    db: Session = Depends(get_db),
) -> dict:
    del user
    if underlying_symbol not in {item["symbol"] for item in FYERS_OPTION_UNDERLYINGS}:
        raise HTTPException(status_code=422, detail="Unsupported market symbol")
    selected_date = _validated_date(expiry_date, "expiry_date")
    if selected_date >= datetime.now(UTC).date():
        raise HTTPException(status_code=422, detail="Expiry date must be in the past")
    start = _validated_date(range_from, "range_from")
    end = _validated_date(range_to, "range_to")
    if end < start or end > selected_date or (end - start).days > 99:
        raise HTTPException(
            status_code=422,
            detail="Historical range must be ordered and at most 100 days",
        )
    if not symbols or len(symbols) > 120:
        raise HTTPException(
            status_code=422, detail="Select between 1 and 120 option contracts"
        )
    requested_symbols = set(symbols)
    if len(requested_symbols) != len(symbols):
        raise HTTPException(status_code=422, detail="Duplicate contract symbols")
    exchange = underlying_symbol.split(":", maxsplit=1)[0]
    if any(
        re.fullmatch(r"(NSE|BSE|MCX):[A-Za-z0-9&_-]+", item) is None
        or not item.startswith(f"{exchange}:")
        or not item.endswith(("CE", "PE"))
        for item in symbols
    ):
        raise HTTPException(status_code=422, detail="Invalid option contract symbols")

    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection is None:
        raise HTTPException(status_code=404, detail="Market account is not connected")
    access_token = _get_access_token(connection, db)
    allowed_symbols = _cached_expired_contracts(underlying_symbol, expiry_date)
    if allowed_symbols is None:
        catalog = _fyers_expired_data(
            "underlying-symbols",
            {"symbol": underlying_symbol, "expiry_date": expiry_date},
            access_token,
        )
        if catalog.get("s") != "ok":
            raise HTTPException(
                status_code=502, detail="Expired contract lookup failed"
            )
        catalog_data = _expired_response_data(catalog)
        contracts = catalog_data.get("contracts")
        if not isinstance(contracts, dict):
            raise HTTPException(
                status_code=502, detail="FYERS returned invalid expired contracts"
            )
        exchange = underlying_symbol.split(":", maxsplit=1)[0]
        allowed_symbols = {
            item
            for item in _expired_symbols(contracts.get("options"))
            if item.startswith(f"{exchange}:")
        }
        _cache_expired_contracts(underlying_symbol, expiry_date, allowed_symbols)
    if not requested_symbols.issubset(allowed_symbols):
        raise HTTPException(
            status_code=422, detail="Contract does not belong to the selected expiry"
        )

    def fetch_contract(contract_symbol: str) -> dict:
        params = {
            "symbol": contract_symbol,
            "resolution": resolution,
            "date_format": "1",
            "range_from": range_from,
            "range_to": range_to,
        }
        if include_oi:
            params["include_oi"] = "1"
        try:
            payload = _fyers_expired_data("historical-data", params, access_token)
        except HTTPException:
            logger.exception("Expired history request failed for %s", contract_symbol)
            return {
                "symbol": contract_symbol,
                "resolution": resolution,
                "candles": [],
                "error": "Historical data request failed for this contract.",
            }
        result = _normalize_expired_candles(
            payload, contract_symbol, resolution, include_oi
        )
        return result

    results = {}
    with ThreadPoolExecutor(max_workers=min(12, len(symbols))) as executor:
        futures = {
            executor.submit(fetch_contract, contract_symbol): contract_symbol
            for contract_symbol in symbols
        }
        for future in as_completed(futures):
            contract_symbol = futures[future]
            results[contract_symbol] = future.result()
    return {
        "underlying_symbol": underlying_symbol,
        "expiry_date": expiry_date,
        "resolution": resolution,
        "range_from": range_from,
        "range_to": range_to,
        "contracts": [results[contract_symbol] for contract_symbol in symbols],
    }


@router.delete("/disconnect", status_code=204)
def disconnect(user: User = Depends(admin_user), db: Session = Depends(get_db)) -> None:
    del user
    connection = db.scalar(
        select(BrokerConnection).where(BrokerConnection.provider == "fyers")
    )
    if connection:
        db.delete(connection)
        db.commit()
