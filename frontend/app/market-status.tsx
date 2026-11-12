"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

type ApiRequest = (path: string, options?: RequestInit) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatus(value: unknown): string {
  if (
    !isRecord(value) ||
    value.exchange !== "NSE" ||
    value.segment !== "FO" ||
    value.market_type !== "NORMAL" ||
    typeof value.status !== "string" ||
    !value.status.trim()
  ) {
    throw new Error("The market-data service returned an invalid NSE derivatives status.");
  }
  return value.status.trim().toUpperCase();
}

export default function MarketStatus({ apiRequest }: { apiRequest: ApiRequest }) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const refreshStatus = async () => {
      try {
        const nextStatus = parseStatus(
          await apiRequest("/api/admin/fyers/market-status"),
        );
        if (!active) return;
        setStatus(nextStatus);
        setError("");
      } catch (caught) {
        if (!active) return;
        setStatus(null);
        setError(
          caught instanceof Error
            ? caught.message.replace(/\bfyers\b/gi, "market data service")
            : "Unable to retrieve NSE derivatives market status.",
        );
      } finally {
        if (active) setLoading(false);
      }
    };

    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [apiRequest]);

  return (
    <section className={styles.marketStatusBar} aria-label="NSE derivatives market status">
      <span
        className={`${styles.marketStatus} ${
          status === "OPEN"
            ? styles.marketStatus_open
            : status && status !== "UNKNOWN" && status !== "UNAVAILABLE"
              ? styles.marketStatus_closed
              : styles.marketStatus_unavailable
        }`}
        role="status"
        aria-live="polite"
        title={error || "NSE derivatives market status"}
      >
        <span aria-hidden="true" />
        {status
          ? status === "UNKNOWN"
            ? "NSE F&O · CHECKING AT 9:16 AM IST"
            : status === "UNAVAILABLE"
              ? "NSE F&O · STATUS UNAVAILABLE TODAY"
              : `NSE F&O · ${status.replace(/_/g, " ")}`
          : loading
            ? "Checking NSE F&O market…"
            : "NSE F&O market status unavailable"}
      </span>
      {error && !loading && (
        <span className={styles.marketStatusError} role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
