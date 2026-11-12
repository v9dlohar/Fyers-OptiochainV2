# Deploy OptionFlow on Ubuntu 24.04 with ngrok

This guide runs the app on one Ubuntu server, uses PostgreSQL, and publishes it
through two ngrok HTTPS endpoints:

- Frontend: public website and FYERS OAuth callback.
- Backend: the browser's secure WebSocket (`wss://`) market-data connection.

The backend HTTP API remains bound to localhost for server-to-server requests
from Next.js. The backend ngrok endpoint is still publicly reachable, so use
strong credentials and keep the app and OS updated. ngrok is a tunnel, not a
replacement for a production hosting, domain, or security setup.

## 1. Connect to Ubuntu and install prerequisites

SSH into the server:

```bash
ssh ubuntu@YOUR_SERVER_IP
```

Update Ubuntu and install Git, PostgreSQL, Python build tools, and utilities:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl ca-certificates build-essential python3-venv \
  python3-dev postgresql postgresql-contrib
```

The backend declares Python **3.13 or newer**. Ubuntu 24.04's default Python
may be older, so install Python 3.13 with `uv`:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source "$HOME/.local/bin/env"
uv python install 3.13
uv python find 3.13
```

Install Node.js 22 (the app requires Node.js 20+ and npm 10+):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

## 2. Get the application code

If the GitHub repository is public:

```bash
sudo mkdir -p /opt/options-chain-app
sudo chown "$USER":"$USER" /opt/options-chain-app
git clone https://github.com/v9dlohar/Fyers-OptiochainV1.git \
  /opt/options-chain-app
cd /opt/options-chain-app
```

If the repository is private, configure an SSH deploy key on the server and
clone using the repository's SSH URL instead. Do not put a GitHub token in the
clone URL.

## 3. Create a PostgreSQL database

Create a dedicated database user and database. Choose a long random password;
hex output is safe to use unescaped in the URL in the next step.

```bash
openssl rand -hex 32
sudo -u postgres psql
```

At the `psql` prompt, replace `PASTE_A_DATABASE_PASSWORD_HERE` with the
generated value:

```sql
CREATE ROLE options_app LOGIN PASSWORD 'PASTE_A_DATABASE_PASSWORD_HERE';
CREATE DATABASE options_chain OWNER options_app;
\q
```

Keep the database on `127.0.0.1`; do not open port 5432 to the internet.

## 4. Install backend dependencies and configure secrets

```bash
cd /opt/options-chain-app/backend
uv venv --python 3.13 .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[market-stream]"
python -m pip install --no-deps fyers-apiv3==3.1.15
```

Generate the application signing secret and the Fernet encryption key:

```bash
openssl rand -hex 32
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Create the backend environment file:

```bash
nano /opt/options-chain-app/backend/.env
```

Paste and fill in the following. Replace every placeholder; do not commit this
file or send its secrets to anyone.

```dotenv
ENVIRONMENT=production
FRONTEND_ORIGIN=https://YOUR-FRONTEND-NGROK-DOMAIN
DATABASE_URL=postgresql+psycopg://options_app:YOUR_DATABASE_PASSWORD@127.0.0.1:5432/options_chain
SECRET_KEY=PASTE_THE_64_CHARACTER_HEX_SECRET
ADMIN_EMAIL=the-admin-email@example.com
FYERS_CLIENT_ID=YOUR_FYERS_APP_ID
FYERS_CLIENT_SECRET=YOUR_FYERS_APP_SECRET
FYERS_PIN=YOUR_FYERS_PIN
FYERS_REDIRECT_URI=https://YOUR-FRONTEND-NGROK-DOMAIN/api/fyers/callback
FYERS_API_BASE_URL=https://api-t1.fyers.in
FYERS_ENCRYPTION_KEY=PASTE_THE_GENERATED_FERNET_KEY
```

Save with `Ctrl+O`, press Enter, and exit with `Ctrl+X`. Restrict access:

```bash
chmod 600 /opt/options-chain-app/backend/.env
```

`ADMIN_EMAIL` must match the administrator's signup email. The first user
registered with this email is made the administrator.

## 5. Install frontend dependencies

The public ngrok URLs are needed below. Start ngrok in step 7, record its two
HTTPS domains, then return here before building the frontend.

```bash
cd /opt/options-chain-app/frontend
npm ci
```

Create the frontend environment file after collecting the ngrok domains:

```bash
nano /opt/options-chain-app/frontend/.env.local
```

```dotenv
API_URL=http://127.0.0.1:8000
NEXT_PUBLIC_API_WS_URL=wss://YOUR-BACKEND-NGROK-DOMAIN/admin/fyers/stream
```

The `NEXT_PUBLIC_API_WS_URL` value is included in the frontend build, so rebuild
the frontend if that public backend URL changes.

## 6. Run database migrations and build

```bash
cd /opt/options-chain-app/backend
source .venv/bin/activate
alembic upgrade head
```

Build the frontend:

```bash
cd /opt/options-chain-app/frontend
npm run build
```

## 7. Install and start ngrok

Follow ngrok's Linux install instructions (APT):

```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update
sudo apt install -y ngrok
```

Get an ngrok authtoken from the ngrok dashboard. Enter it without putting the
token itself in shell history:

```bash
read -rsp "Paste ngrok authtoken: " NGROK_AUTHTOKEN
echo
ngrok config add-authtoken "$NGROK_AUTHTOKEN"
unset NGROK_AUTHTOKEN
```

Open two SSH terminals to the server. In the first, publish Next.js:

```bash
ngrok http 3000
```

In the second, publish the backend for its WebSocket:

```bash
ngrok http 8000
```

Record each displayed `https://...` forwarding URL:

- The port-3000 URL is `YOUR-FRONTEND-NGROK-DOMAIN`.
- The port-8000 URL is `YOUR-BACKEND-NGROK-DOMAIN`.
- For the browser WebSocket, use the backend host with `wss://`, not `https://`.

The free/ephemeral domains can change when ngrok restarts. If they change,
update the settings below, update FYERS's registered callback URL, rebuild the
frontend, and restart both app services. For a stable deployment, use ngrok
domains that remain reserved to your account.

## 8. Register the FYERS OAuth callback

In the FYERS developer app settings, register this exact redirect URI:

```text
https://YOUR-FRONTEND-NGROK-DOMAIN/api/fyers/callback
```

It must exactly match `FYERS_REDIRECT_URI` in `backend/.env`. Update
`FRONTEND_ORIGIN` in the same file to the frontend HTTPS origin, with no trailing
slash. Update `NEXT_PUBLIC_API_WS_URL` in `frontend/.env.local` to
`wss://YOUR-BACKEND-NGROK-DOMAIN/admin/fyers/stream`.

## 9. Add systemd services

Run the API with one worker. The shared feed poller is process-local, so do not
increase the Uvicorn worker count.

```bash
sudo tee /etc/systemd/system/options-backend.service >/dev/null <<'EOF'
[Unit]
Description=OptionFlow FastAPI backend
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/options-chain-app/backend
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/options-chain-app/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Run Next.js in production mode:

```bash
sudo tee /etc/systemd/system/options-frontend.service >/dev/null <<'EOF'
[Unit]
Description=OptionFlow Next.js frontend
After=network.target options-backend.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/options-chain-app/frontend
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Build once more with the final WebSocket URL, then enable and start both:

```bash
cd /opt/options-chain-app/frontend
npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now options-backend options-frontend
sudo systemctl status options-backend options-frontend --no-pager
```

Check local health:

```bash
curl -fsS http://127.0.0.1:8000/health
curl -I http://127.0.0.1:3000
```

View service logs if something fails:

```bash
sudo journalctl -u options-backend -n 100 --no-pager
sudo journalctl -u options-frontend -n 100 --no-pager
```

## 10. Finish setup and verify

1. Open the **frontend ngrok HTTPS URL** in a browser.
2. Register using the email configured as `ADMIN_EMAIL`.
3. Sign in, connect FYERS, and complete its OAuth flow.
4. Confirm the FYERS redirect returns to the frontend ngrok URL.
5. On the dashboard, confirm market status and the option chain load.
6. Confirm the browser connects to the backend WebSocket using `wss://`.
7. Check the admin daily request-usage table.

The table tracks requests from deployment onward; it cannot recover earlier
same-day requests. It displays usage but does not stop calls at the 5,000 daily
limit. The poller is shared by the users on this one backend process.

The app's default SQLite database is in the backend directory, but this guide
uses PostgreSQL for concurrent application use. Back up PostgreSQL regularly
and keep copies of both `.env` files secure.

## Updating the deployment

```bash
cd /opt/options-chain-app
git pull
cd backend
source .venv/bin/activate
python -m pip install -e ".[market-stream]"
python -m pip install --no-deps fyers-apiv3==3.1.15
alembic upgrade head
cd ../frontend
npm ci
npm run build
sudo systemctl restart options-backend options-frontend
```

Keep both ngrok endpoint processes running. For restart-surviving tunnels, use
stable ngrok domains and configure the ngrok agent to start at boot.

Official ngrok references:

- [Install ngrok on Linux](https://ngrok.com/download/linux)
- [ngrok agent configuration](https://ngrok.com/docs/gateway/agent/config/)
