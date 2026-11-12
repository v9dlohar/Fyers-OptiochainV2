# Options Chain App

Monorepo foundation for a FastAPI backend and a Next.js TypeScript frontend.

## Repository layout

```text
backend/   FastAPI application and Python tooling
frontend/  Next.js application and TypeScript tooling
```

## Prerequisites

- Python 3.11+
- Node.js 20+
- npm 10+

## Local setup

### Backend

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,market-stream]"
# The official socket SDK pins legacy dependencies; install its pure-Python wheel
# without those pins because its required runtime libraries are installed above.
python -m pip install --no-deps fyers-apiv3==3.1.15
Copy-Item .env.example .env
uvicorn app.main:app --reload
```

The API is available at <http://127.0.0.1:8000>; its health endpoint is
<http://127.0.0.1:8000/health>.

### Frontend

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
npm run dev
```

The web app is available at <http://localhost:3000>.

## Quality checks

```powershell
# backend
cd backend
ruff check .
pytest

# frontend
cd frontend
npm run lint
npm run typecheck
```

The app includes authentication, an admin-only FYERS OAuth connection, and an
admin-only option-chain workspace.

## Authentication API

The backend exposes these endpoints under `/auth`:

- `POST /auth/register` creates a user with a normalized mobile number and an
  Argon2 password hash. Password confirmation is validated on the signup page;
  the original password is never exposed to administrators.
- `POST /auth/login` returns a short-lived access token and a rotating refresh token.
- A user may have only one active login; signing in again invalidates access and
  refresh tokens from the previous device.
- `POST /auth/refresh` revokes the submitted refresh token and issues a replacement pair.
- `POST /auth/logout` revokes a refresh token.
- `GET /auth/me` returns the authenticated user and requires an access-token bearer header.
- Open pages check the active login periodically and return to sign-in when the
  session expires, is revoked, or is replaced by another login.
- Administrators can view each account's login ID and mobile number, assign or
  renew a license for a specified number of days, and generate a one-time
  temporary password. Temporary-password users must change it before accessing
  the workspace. License access expires automatically at the configured date.
- New accounts begin with market-data access pending. The configured administrator
  reviews signups at `GET /admin/users` and activates or revokes a license with
  `PATCH /admin/users/{user_id}/license`. Market-data endpoints enforce license
  status on the backend; pending users can sign in to see their activation status,
  payment instructions, and a UPI QR code, but cannot retrieve option-chain or
  live-stream data. Users are asked to send their payment screenshot to
  WhatsApp +91 99873 76064; users who have already paid can wait for activation.

The application uses SQLite as the safe local fallback when no `.env` file is
present, while `backend/.env.example` is configured for PostgreSQL. Run Alembic
migrations from `backend` after schema changes and before using a configured
PostgreSQL database:

```powershell
alembic upgrade head
```

Refresh tokens are stored only as SHA-256 hashes. The JWT signing secret must be
replaced with a high-entropy deployment secret before using the service outside
local development.

### Admin FYERS connection

Set `ADMIN_EMAIL` to the exact email of the administrator and configure
`FYERS_CLIENT_ID`, `FYERS_CLIENT_SECRET`, `FYERS_PIN`, `FYERS_REDIRECT_URI` and
`FYERS_API_BASE_URL` in `backend/.env`. The redirect URI should remain
`http://localhost:3000/api/fyers/callback`; the Next.js route proxies it to the
backend callback. Generate a separate Fernet key for `FYERS_ENCRYPTION_KEY`
(for example, `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).
The backend refuses to connect if this key is missing or invalid and stores
access and refresh tokens only in encrypted database columns.

An authenticated administrator starts the provider flow with
`GET /admin/fyers/login`. The server stores a short-lived, one-time hashed state,
exchanges the returned authorization code at FYERS
`/api/v3/validate-authcode`, and never returns tokens to the browser. Status and
disconnect are available at `GET /admin/fyers/status` and
`DELETE /admin/fyers/disconnect`; profile verification is available at
`GET /admin/fyers/profile`. These endpoints require the admin JWT. After
completing FYERS authorization, use **Test FYERS Profile** in the admin panel to
confirm the connection with an authenticated provider profile request. When
available, the returned name, email, and FYERS ID are displayed. Automated
profile tests mock FYERS responses; verifying a live account also requires
valid app credentials and completing the OAuth consent flow. `FYERS_PIN` is
required by FYERS's refresh-token endpoint. The backend uses it to renew an
expiring market-data access token automatically and stores any rotated access
and refresh tokens encrypted in the database. Keep the PIN only in the
untracked `backend/.env`; do not commit it. If the refresh token expires or is
revoked, reconnect the FYERS account through the OAuth flow.

### FYERS option chain

The authenticated administrator workspace includes an option-chain view. The
searchable underlying picker uses FYERS underlying-symbol formats: index symbols
use `EXCHANGE:NAME-INDEX` (for example `NSE:NIFTY50-INDEX`) and equity
underlyings use `NSE:TICKER-EQ` (for example `NSE:SBIN-EQ`). Option contract
symbols and available expiry dates are taken from FYERS rather than composed
locally. Expiry selection uses the exact epoch timestamp returned by
`expiryData`, so expired or unlisted dates are rejected.

The backend proxies FYERS `/data/options-chain-v3` and requests up to 50 strikes
on either side with `greeks=1`. The UI defaults to 10 strikes either side and
can display up to all 50 available on each side; its strike-range selector
filters the display locally. The table
displays FYERS's per-contract Delta, Gamma, Theta, Vega, implied volatility,
quoted LTP, and raw per-strike open interest, volume, and change in open
interest, each with a percentage-share badge in the same cell. Each badge uses
the highest matching Calls or Puts value in the currently selected strike range
as 100%, with the other strikes scaled relative to that maximum independently
for OI, OI change, and volume. OI-change badges retain the change sign and are
ranked by absolute change. Maximum values are highlighted green and the
second-largest distinct displayed values yellow; ties in displayed values use
the same highlight. The table also shows intrinsic value
and time-value decomposition derived from FYERS spot, strike, and quoted LTP.

NSE F&O market status is requested from FYERS `/data/marketStatus` once per
trading weekday at or after 9:16 AM IST and before 3:30 PM IST. The check date
and result are stored in the database, so application restarts do not trigger
another request that day. Before 9:16 AM the status is shown as pending; after
3:30 PM and on weekends it is treated as closed without a provider request.
Every authenticated user can view this status, including accounts whose
license activation is pending; access to option-chain and other market data
remains license-gated.

While the market is open, the backend fetches the NIFTY 50 default-expiry chain
once per configured interval (1–5 seconds, default 5) and shares that snapshot
with all users. The administrator changes this interval in the Market Data
connection panel. Users poll the backend for the shared snapshot; they do not
each trigger a FYERS request. The poller stops fetching outside regular trading
hours or when FYERS reports the market closed at the daily check. A special
early market close after the 9:16 check is not detected until 3:30 PM. Other
underlyings and manually selected non-default expiries remain on-demand and
their quote updates use the shared backend WebSocket feed. The default NIFTY
chain does not apply faster WebSocket ticks over the shared snapshot, so its
displayed option and spot values change with the configured server snapshot.

History requests with identical parameters are shared for five minutes, and
expired-data responses are shared for one day. The floating spot chart fetches
history only while open; the historical workspace reuses the spot candles it
already loaded. FYERS 429 responses are not retried immediately: the backend
honors `Retry-After` when supplied, pauses market-data requests during the
cooldown, and labels cached chains as stale with their last successful update.

The poller and its live snapshot are process-local. Run a single backend worker
so multiple application workers do not independently poll FYERS. The stated
Standard-plan quota is 5,000 requests per day. At a 5-second interval, NIFTY
alone can use about 4,500 option-chain calls in a 6-hour-15-minute session,
leaving about 500 requests for all other FYERS endpoints; a 1-second interval
can use about 22,500 and exceed the quota. The admin Market Data panel shows
the current IST day's FYERS REST request attempts, the 5,000-request limit, and
the remaining balance. The persistent counter includes failed REST attempts,
but excludes WebSocket ticks, cached responses, and the public symbol-master
download. Tracking starts with deployment and does not backfill requests made
earlier that day. It is a monitor only and does not stop requests at the quota,
so choose the polling interval with the remaining endpoints in mind.

FYERS Greeks and LTP remain provider values; this application does not predict
or calculate LTP. Only the configured administrator can retrieve market data;
the broker access token remains encrypted at rest and is not returned to the
frontend.

The option-chain table spans the workspace width. Viewers can choose between
seven page color themes; the default is Glossy White Milky, and the selection is
saved in browser local storage and a cookie so the selected theme is applied in
server-rendered pages without a light-theme flash. The default strike range
shows 10 strikes either side of ATM, with options to show up to all 50 strikes
either side.
The authenticated FYERS data socket streams spot and option-contract quote
updates into the page and chart without a page reload. The NIFTY default-expiry
snapshot refreshes from the shared backend at the administrator-selected
interval, including provider Greeks; other chains can be refreshed on demand.
WebSocket tick updates apply to non-default chains. The WebSocket URL defaults
to the same host on port 8000; set `NEXT_PUBLIC_API_WS_URL` when the API uses a
different public URL.

The shared underlying list includes the NIFTY 50 equity symbols and supported
index underlyings; it is available in both the home and historical pages, and
the historical underlying picker combines search and selection in one control.
Both option-chain tables use compact numeric columns and provide a **Lots**
toggle for volume, open interest, and OI change. Lot conversions use the
contract's `minLotSize` from the FYERS NSE/BSE instrument master; missing lot
sizes are shown as unavailable rather than estimated.
The floating chart height can be resized independently on either page. Its
default height is 544px (20% below the original 680px), and existing saved
chart heights are reduced by 20% once while preserving their positions.
Candle intervals remain visible at narrow chart widths. The market-data instrument universe
may change; an unsupported underlying returns a visible market-data error. For API parameters, expiry behavior,
response fields, and Greek units, see the
[official FYERS API v3 documentation](https://myapi.fyers.in/docsv3) and the
[FYERS NSE derivatives symbol master](https://public.fyers.in/sym_details/NSE_FO_sym_master.json).

### Spot candlestick chart

The option-chain workspace includes a candlestick chart for the selected
underlying spot symbol. Candle OHLCV data is requested only from FYERS
`/data/history` through the authenticated `GET /admin/fyers/history` endpoint;
the chart does not use another data provider or generate fallback candles.
Supported resolutions are 1, 5, 15, 30, and 60 minutes and daily. The chart
includes volume, crosshair, and zoom. The floating window and plot are
opaque. Drawing controls have been removed to maximize the candle plot area.
The latest candle is positioned near the center of the visible time range. The
chart is a floating, draggable, resizable panel; its size and position are
saved in browser storage, and it can be minimized and reopened.
Historical option-chain volume is accumulated from the provider's interval
candles within each India trading day during replay; the spot-chart volume bars
continue to represent individual candle volume.
Chart time labels use the India exchange time zone. **Replay** lets the user
click a candle to select a historical starting point, then play, pause, or step
one provider candle at a time. The replay anchor is retained when switching
intervals and mapped to the matching candle in the new interval. Right-clicking
the chart opens a context menu with **Reset chart view**, which shows a readable
recent candle window and auto-scales the price axis. History is fetched when
the selected symbol or interval changes. While replay is inactive, chart
candles update in place from the FYERS quote socket; replay pauses live chart
updates until replay exits.

### Historical expired contracts

The **Historical options** page opens in a new tab from the connected home
workspace. Its date range defaults to the previous three calendar months and
cannot exceed three calendar months; choosing a start date automatically sets
the end date to the earlier of three months later or today. First choose an
underlying and date range; the returned expired option dates appear in the
expiry selector using the same day-month-year display as the live chain.
Selecting an expiry loads its provider-returned option symbols. Spot and option
candles start on the day after the preceding returned expiry and continue
through the selected expiry, subject to the historical endpoint's 100-day
limit. The replay controls and position slider are attached to the draggable
floating chart.
If FYERS rejects a broad expiry lookup range as invalid, the backend retries it
in calendar-month segments and reports when some segments are unavailable.
Choose the interval and strike range in the expired-options selector panel.
Selecting an expiry loads a timestamp-aligned historical option-chain table
using the same Calls / Strike / Puts layout as the live chain. Each side shows
volume, open interest, and LTP (the candle close); OI is included by default
without a separate checkbox. Contract history is fetched for strikes around
the underlying's spot prices across the loaded replay period, so the visible
strike range can follow spot without showing contracts that were never
requested. The floating spot chart and option-chain values share one replay
time cursor and can be stepped or played together. The table appears after all
required contract histories have loaded; requests are sent in batches of up to
120 contracts.

The backend proxies these calls through admin-authenticated endpoints:

- `GET /admin/fyers/expired/expiry-dates` calls
  `/data/history/fno/expired/expiry-dates`.
- `GET /admin/fyers/expired/contracts` calls
  `/data/history/fno/expired/underlying-symbols`.
- `GET /admin/fyers/expired/history` calls
  `/data/history/fno/expired/historical-data`.
- `POST /admin/fyers/expired/chain-history` validates symbols against the
  selected expiry, reuses the recent expiry catalog when available, then fetches
  up to 120 per-contract history series with bounded parallelism for the aligned
  chain table.

Only intraday intervals are currently supported: 5 seconds, and 1, 2, 3, 5,
10, 15, 20, 30, 45, 60, 120, 180, and 240 minutes. Requests are limited to 100
days; 5-second data is limited to the most recent 30 trading days. Historical
data availability begins on 10 October 2018 for NSE, 7 August 2023 for BSE,
and 11 October 2018 for MCX. The page uses FYERS's returned contract symbols
and candle values; it does not fabricate missing candles.
For the spot chart, 5-second option candles are paired with 1-minute spot
candles because the regular spot-history endpoint has no 5-second interval.

FYERS provides expired-contract catalogs and per-contract history, but not a
timestamp-aligned historical option-chain snapshot endpoint. This page aligns
the returned individual contract candles by timestamp to build the historical
chain table; strikes with no candle at or before the replay timestamp remain
blank. Historical Greeks are documented as coming soon and are not displayed.
For exact request and response fields, see the
[official Expired F&O Contracts Data documentation](https://myapi.fyers.in/docsv3#tag/Expired-FnO-Contracts-Data).

## Initial technical references

The first implementation milestone follows the current official guidance for:

- [FastAPI OAuth2 with password and JWT](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)
- [FastAPI testing](https://fastapi.tiangolo.com/tutorial/testing/)
- [SQLAlchemy 2.0 ORM](https://docs.sqlalchemy.org/en/20/orm/quickstart.html)
- [Alembic migrations](https://alembic.sqlalchemy.org/en/latest/tutorial.html)
- [pwdlib password hashing](https://frankie567.github.io/pwdlib/)
- [Next.js App Router](https://nextjs.org/docs/app)

Authentication will use Argon2 password hashing and short-lived JWT access tokens
with server-side refresh-token rotation and revocation. Secrets and database
credentials will be supplied through deployment configuration, never committed.
