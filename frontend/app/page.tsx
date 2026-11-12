"use client";

import { FormEvent, useEffect, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import styles from "./page.module.css";
import MarketStatus from "./market-status";
import OptionChainWorkspace from "./option-chain";

type User = {
  id: number;
  email: string;
  is_active: boolean;
  license_active: boolean;
  must_change_password: boolean;
  is_admin: boolean;
  created_at: string;
};

type ThemeId =
  | "glossy-milk"
  | "midnight"
  | "soft-sage"
  | "ocean"
  | "lavender"
  | "warm-sand"
  | "high-contrast";

const THEMES: { id: ThemeId; name: string }[] = [
  { id: "glossy-milk", name: "Glossy White Milky" },
  { id: "midnight", name: "Midnight" },
  { id: "soft-sage", name: "Soft Sage" },
  { id: "ocean", name: "Ocean Blue" },
  { id: "lavender", name: "Lavender" },
  { id: "warm-sand", name: "Warm Sand" },
  { id: "high-contrast", name: "High Contrast" },
];

function isThemeId(value: string): value is ThemeId {
  return THEMES.some((item) => item.id === value);
}

type FyersStatus = {
  connected: boolean;
  connected_at: string | null;
};

type FyersProfileDetails = {
  name: string | null;
  email: string | null;
  fyersId: string | null;
};

type FyersApiUsage = {
  date: string;
  daily_limit: number;
  requests_used: number;
  requests_remaining: number;
};

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileValue(profile: unknown, keys: string[]): string | null {
  if (!isRecord(profile)) return null;
  const data = isRecord(profile.data) ? profile.data : profile;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

let sessionRefresh: Promise<boolean> | null = null;

async function request(path: string, options?: RequestInit) {
  const fetchResponse = () => fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  let response = await fetchResponse();
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    if (!sessionRefresh) {
      sessionRefresh = fetch("/api/auth/me", { cache: "no-store" })
        .then((session) => session.ok)
        .finally(() => {
          sessionRefresh = null;
        });
    }
    if (await sessionRefresh) response = await fetchResponse();
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      typeof body?.detail === "string" ? body.detail : "Something went wrong.",
      response.status,
    );
  }
  return body;
}

function userFacingError(caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message : fallback;
  return message.replace(/\bfyers\b/gi, "market data service");
}

function startFyersLogin() {
  // A full navigation avoids handling the provider's 307 OAuth redirect as an RSC payload.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/api/admin/fyers/login");
}

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [fyers, setFyers] = useState<FyersStatus | null>(null);
  const [fyersLoading, setFyersLoading] = useState(false);
  const [fyersError, setFyersError] = useState("");
  const [fyersProfileChecked, setFyersProfileChecked] = useState(false);
  const [fyersProfile, setFyersProfile] = useState<FyersProfileDetails | null>(null);
  const [fyersRefreshInterval, setFyersRefreshInterval] = useState(5);
  const [feedSettingsSaving, setFeedSettingsSaving] = useState(false);
  const [feedSettingsError, setFeedSettingsError] = useState("");
  const [fyersApiUsage, setFyersApiUsage] = useState<FyersApiUsage | null>(null);
  const [fyersApiUsageError, setFyersApiUsageError] = useState("");
  const [theme, setTheme] = useState<ThemeId>("glossy-milk");
  const [themeLoaded, setThemeLoaded] = useState(false);

  useLayoutEffect(() => {
    try {
      const storedTheme = window.localStorage.getItem("optionflow-theme");
      if (storedTheme && isThemeId(storedTheme)) {
        setTheme(storedTheme);
        document.documentElement.dataset.theme = storedTheme;
        document.cookie = `optionflow-theme=${encodeURIComponent(storedTheme)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }
    } finally {
      setThemeLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!themeLoaded) return;
    window.localStorage.setItem("optionflow-theme", theme);
    document.documentElement.dataset.theme = theme;
    document.cookie = `optionflow-theme=${encodeURIComponent(theme)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [theme, themeLoaded]);

  useEffect(() => {
    request("/api/auth/me", { signal: AbortSignal.timeout(12_000) })
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handleSessionExpired() {
      setUser(null);
      setFyers(null);
      setFyersProfileChecked(false);
      setFyersProfile(null);
      setError("Your session has ended. Please sign in again.");
    }
    function handleLicenseDeactivated(event: Event) {
      const session = (event as CustomEvent<User>).detail;
      setUser(session);
      setFyers(null);
      setFyersProfileChecked(false);
      setFyersProfile(null);
      setFyersError("");
    }
    window.addEventListener("optionflow:session-expired", handleSessionExpired);
    window.addEventListener(
      "optionflow:license-deactivated",
      handleLicenseDeactivated,
    );
    return () => {
      window.removeEventListener("optionflow:session-expired", handleSessionExpired);
      window.removeEventListener(
        "optionflow:license-deactivated",
        handleLicenseDeactivated,
      );
    };
  }, []);

  useEffect(() => {
    if (!user || (!user.is_admin && !user.license_active)) return;
    void (async () => {
      setFyersLoading(true);
      setFyersError("");
      try {
        setFyers(await request("/api/admin/fyers/status"));
      } catch (caught) {
        setFyersError(userFacingError(caught, "Unable to load connection status."));
      } finally {
        setFyersLoading(false);
      }
    })();
  }, [user]);

  useEffect(() => {
    if (!user?.is_admin) return;
    let active = true;
    const loadUsage = async () => {
      try {
        const value: unknown = await request("/api/admin/fyers/api-usage");
        if (
          !isRecord(value) ||
          typeof value.date !== "string" ||
          typeof value.daily_limit !== "number" ||
          typeof value.requests_used !== "number" ||
          typeof value.requests_remaining !== "number"
        ) {
          throw new Error("The daily Fyers API usage response is invalid.");
        }
        if (active) {
          setFyersApiUsage({
            date: value.date,
            daily_limit: value.daily_limit,
            requests_used: value.requests_used,
            requests_remaining: value.requests_remaining,
          });
          setFyersApiUsageError("");
        }
      } catch (caught) {
        if (active) {
          setFyersApiUsageError(
            userFacingError(caught, "Unable to load daily Fyers API usage."),
          );
        }
      }
    };
    void loadUsage();
    const timer = window.setInterval(() => void loadUsage(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [user]);

  useEffect(() => {
    if (!user || (!user.is_admin && !user.license_active)) return;
    let active = true;
    let loaded = false;
    const loadSettings = () => {
      request("/api/admin/fyers/feed-settings")
        .then((value) => {
        if (!isRecord(value) || typeof value.refresh_interval_seconds !== "number") {
          throw new Error("The shared feed interval is invalid.");
        }
        if (active && value.refresh_interval_seconds >= 1 && value.refresh_interval_seconds <= 5) {
          setFyersRefreshInterval(value.refresh_interval_seconds);
        }
        loaded = true;
      })
        .catch((caught: unknown) => {
          if (active && user.is_admin && !loaded) {
            setFeedSettingsError(
              caught instanceof Error ? caught.message : "Unable to load feed settings.",
            );
          }
        });
    };
    loadSettings();
    const timer = window.setInterval(loadSettings, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setUser(await request("/api/auth/me"));
      setPassword("");
      if (new URLSearchParams(window.location.search).get("returnTo") === "/historical") {
        router.replace("/historical");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to authenticate.");
    } finally {
      setSubmitting(false);
    }
  }

  async function logout() {
    setSubmitting(true);
    try {
      await request("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setFyers(null);
      setFyersProfileChecked(false);
      setFyersProfile(null);
      setSubmitting(false);
    }
  }

  async function changeTemporaryPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmNewPassword) {
      setError("New passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const updated = await request("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          new_password: newPassword,
        }),
      });
      setUser(updated as User);
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (caught) {
      setError(userFacingError(caught, "Unable to change your password."));
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshLicenseStatus() {
    try {
      setUser(await request("/api/auth/me"));
    } catch (caught) {
      setError(userFacingError(caught, "Unable to refresh your activation status."));
    }
  }

  async function disconnectFyers() {
    setFyersLoading(true);
    setFyersError("");
    try {
      await request("/api/admin/fyers/disconnect", { method: "DELETE" });
      setFyers({ connected: false, connected_at: null });
      setFyersProfile(null);
      setFyersProfileChecked(false);
    } catch (caught) {
      setFyersError(userFacingError(caught, "Unable to disconnect the market account."));
    } finally {
      setFyersLoading(false);
    }

  }

  async function testFyersProfile() {
    setFyersLoading(true);
    setFyersError("");
    setFyersProfileChecked(false);
    setFyersProfile(null);
    try {
      const profile: unknown = await request("/api/admin/fyers/profile");
      setFyersProfile({
        name: profileValue(profile, ["display_name", "displayName", "name"]),
        email: profileValue(profile, ["email_id", "emailId", "email"]),
        fyersId: profileValue(profile, ["fy_id", "fyId", "user_id", "userId"]),
      });
      setFyersProfileChecked(true);
    } catch (caught) {
      setFyersProfile(null);
      setFyersError(userFacingError(caught, "Unable to verify the market account."));
    } finally {
      setFyersLoading(false);
    }
  }

  async function saveFyersRefreshInterval() {
    setFeedSettingsSaving(true);
    setFeedSettingsError("");
    try {
      const value = await request("/api/admin/fyers/feed-settings", {
        method: "PUT",
        body: JSON.stringify({
          refresh_interval_seconds: fyersRefreshInterval,
        }),
      });
      if (!isRecord(value) || typeof value.refresh_interval_seconds !== "number") {
        throw new Error("The shared feed interval could not be saved.");
      }
      setFyersRefreshInterval(value.refresh_interval_seconds);
    } catch (caught) {
      setFeedSettingsError(
        caught instanceof Error ? caught.message : "Unable to save feed settings.",
      );
    } finally {
      setFeedSettingsSaving(false);
    }
  }

  if (loading) {
    return <main className={styles.page}><div className={styles.card}><p>Checking your session…</p></div></main>;
  }

  if (user?.must_change_password) {
    return (
      <main className={styles.page}>
        <section className={styles.card}>
          <div className={styles.brand}>OPTION<span>FLOW</span></div>
          <p className={styles.eyebrow}>Password reset</p>
          <h1>Set a new password.</h1>
          <p className={styles.muted}>
            Choose a new password to continue.
          </p>
          <form onSubmit={changeTemporaryPassword} className={styles.form}>
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
            <label htmlFor="confirm-new-password">Retype new password</label>
            <input
              id="confirm-new-password"
              type="password"
              value={confirmNewPassword}
              onChange={(event) => setConfirmNewPassword(event.target.value)}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
            {error && <p className={styles.error} role="alert">{error}</p>}
            <button className={styles.primaryButton} disabled={submitting}>
              {submitting ? "Updating…" : "Change password"}
            </button>
          </form>
          <button className={styles.linkButton} onClick={() => void logout()} disabled={submitting}>
            Sign out
          </button>
        </section>
      </main>
    );
  }

  if (user) {
    return (
      <main className={styles.appPage} data-theme={theme}>
        <div className={styles.appShell}>
          <header className={styles.topbar}>
            <div className={styles.brand}>OPTION<span>FLOW</span></div>
            <div className={styles.account}>
              <span className={styles.accountDot} aria-hidden="true" />
              <label className={styles.themePicker}>
                <span>Theme</span>
                <select
                  value={theme}
                  onChange={(event) => {
                    const nextTheme = event.target.value;
                    if (isThemeId(nextTheme)) setTheme(nextTheme);
                  }}
                >
                  {THEMES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <span>{user.email}</span>
              <button onClick={logout} disabled={submitting}>
                {submitting ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </header>

          <div className={styles.dashboardHeading}>
            <div>
              <h1>Market Intelligence</h1>
            </div>
            {(user.is_admin || user.license_active) && fyers?.connected && (
              <Link
                className={styles.historicalLink}
                href="/historical"
                target="_blank"
                rel="noopener noreferrer"
              >
                Historical options <span aria-hidden="true">↗</span>
              </Link>
            )}
            {user.is_admin && (
              <Link className={styles.historicalLink} href="/admin/users">
                Manage users <span aria-hidden="true">↗</span>
              </Link>
            )}
          </div>

          <MarketStatus apiRequest={request} />

          {user.is_admin && (
            <section className={styles.connectionBar} aria-label="Market data connection">
              <div className={styles.connectionIdentity}>
                <span className={styles.fyersMark} aria-hidden="true">M</span>
                <div>
                  <strong>MARKET DATA</strong>
                  <span className={styles.connectionStatus}>
                    <i className={fyers?.connected ? styles.statusOnline : styles.statusOffline} />
                    {fyersLoading ? "Checking connection…" : fyers?.connected ? "Connected" : "Not connected"}
                  </span>
                </div>
              </div>
              <div className={styles.connectionActions}>
                {!fyersLoading && !fyers?.connected && (
                  <button
                    className={styles.connectButton}
                    onClick={startFyersLogin}
                  >
                    Connect account
                  </button>
                )}
                {!fyersLoading && fyers?.connected && (
                  <>
                    <button className={styles.subtleButton} onClick={testFyersProfile} disabled={fyersLoading}>
                      Verify connection
                    </button>
                    <button className={styles.subtleButton} onClick={disconnectFyers} disabled={fyersLoading}>
                      Disconnect
                    </button>
                  </>
                )}
                {fyers?.connected && (
                  <>
                    <span className={styles.connectionStatus}>
                      NIFTY default expiry · 1 request per interval
                    </span>
                    <label className={styles.themePicker}>
                      <span>Chain refresh</span>
                      <select
                        aria-label="Shared NIFTY option-chain refresh interval"
                        value={fyersRefreshInterval}
                        onChange={(event) => {
                          const interval = Number(event.target.value);
                          if (interval >= 1 && interval <= 5) setFyersRefreshInterval(interval);
                        }}
                      >
                        {[1, 2, 3, 4, 5].map((interval) => (
                          <option key={interval} value={interval}>{interval} second{interval === 1 ? "" : "s"}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className={styles.subtleButton}
                      onClick={() => void saveFyersRefreshInterval()}
                      disabled={feedSettingsSaving}
                    >
                      {feedSettingsSaving ? "Saving…" : "Save interval"}
                    </button>
                  </>
                )}
              </div>
              <div className={styles.apiUsagePanel}>
                <strong>Fyers API requests today (IST)</strong>
                {fyersApiUsageError ? (
                  <p className={styles.connectionError} role="alert">{fyersApiUsageError}</p>
                ) : fyersApiUsage ? (
                  <>
                    <p className={styles.apiUsageDate}>{fyersApiUsage.date}</p>
                    <table className={styles.apiUsageTable}>
                      <thead>
                        <tr>
                          <th scope="col">Daily limit</th>
                          <th scope="col">Used</th>
                          <th scope="col">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>{fyersApiUsage.daily_limit.toLocaleString()}</td>
                          <td>{fyersApiUsage.requests_used.toLocaleString()}</td>
                          <td>{fyersApiUsage.requests_remaining.toLocaleString()}</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className={styles.apiUsageNote}>
                      Counts outbound REST API requests sent to Fyers, including failed attempts;
                      cached responses and WebSocket ticks are not counted. This is a monitor, not
                      an automatic request cap. Tracking starts with this deployment and does not
                      backfill requests made earlier today.
                    </p>
                  </>
                ) : (
                  <p className={styles.apiUsageDate} role="status">Loading usage…</p>
                )}
              </div>
              {fyersError && <p className={styles.connectionError} role="alert">{fyersError}</p>}
              {feedSettingsError && <p className={styles.connectionError} role="alert">{feedSettingsError}</p>}
              {fyersProfileChecked && (
                <div className={styles.connectionVerified} role="status" aria-live="polite">
                  <strong>Verified</strong>
                  {fyersProfile?.name && <span>{fyersProfile.name}</span>}
                  {fyersProfile?.email && <span>{fyersProfile.email}</span>}
                  {fyersProfile?.fyersId && <span>ID {fyersProfile.fyersId}</span>}
                </div>
              )}
            </section>
          )}

          {!user.is_admin && !user.license_active ? (
            <section
              className={`${styles.connectPrompt} ${styles.paymentPrompt}`}
              aria-labelledby="payment-pending-title"
            >
              <div className={styles.paymentInstructions}>
                <span className={styles.promptIcon} aria-hidden="true">⌁</span>
                <h2 id="payment-pending-title">Activation is pending</h2>
                <p>
                  To activate your subscription, scan the UPI QR code and make
                  your payment. Send a screenshot of the payment to WhatsApp{" "}
                  <a href="https://wa.me/919987376064" target="_blank" rel="noopener noreferrer">
                    +91 99873 76064
                  </a>.
                </p>
                <p>
                  If you have already made the payment, please ignore this
                  message and wait for your account to be activated.
                </p>
                <button className={styles.subtleButton} onClick={() => void refreshLicenseStatus()}>
                  Check activation status
                </button>
              </div>
              <Image
                className={styles.paymentQr}
                src="/payment-qr.jpg"
                alt="UPI payment QR code"
                width={405}
                height={720}
                priority
              />
            </section>
          ) : fyers?.connected ? (
            <OptionChainWorkspace
              apiRequest={request}
              refreshIntervalSeconds={fyersRefreshInterval}
            />
          ) : user.is_admin ? (
            <section className={styles.connectPrompt}>
              <span className={styles.promptIcon} aria-hidden="true">↗</span>
              <h2>Connect your market account</h2>
              <p>Authorize your account to load live option chains, valid expiry dates, and market-data Greeks.</p>
            </section>
          ) : (
            <section className={styles.connectPrompt}>
              <span className={styles.promptIcon} aria-hidden="true">⌁</span>
              <h2>Market data is not connected</h2>
              <p>Please contact the administrator to restore the shared market-data connection.</p>
            </section>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brand}>OPTION<span>FLOW</span></div>
        <p className={styles.eyebrow}>Secure sign in</p>
        <h1>Welcome back.</h1>
        <p className={styles.muted}>Sign in to access your options workspace.</p>
        <form onSubmit={submit} className={styles.form}>
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoComplete="current-password" />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.primaryButton} disabled={submitting}>
            {submitting ? "Please wait…" : "Sign in"}
          </button>
        </form>
        <Link className={styles.linkButton} href="/signup">Need an account? Register</Link>
      </section>
    </main>
  );
}
