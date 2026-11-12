"use client";

import Link from "next/link";
import type { UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import pageStyles from "../page.module.css";
import SpotChart from "../spot-chart";
import styles from "./historical.module.css";
import HistoricalOptionChain from "./historical-option-chain";

type Underlying = { label: string; symbol: string; type: string };
type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  open_interest: number | null;
};
type Resolution = "5S" | "1" | "2" | "3" | "5" | "10" | "15" | "20" | "30" | "45" | "60" | "120" | "180" | "240";
type ContractRow = { strike: string; call: string | null; put: string | null };
type ContractHistory = { candles: Candle[]; error: string | null };
type SpotResolution = Exclude<Resolution, "5S">;
type ThemeId =
  | "glossy-milk"
  | "midnight"
  | "soft-sage"
  | "ocean"
  | "lavender"
  | "warm-sand"
  | "high-contrast";

const THEME_IDS: ThemeId[] = [
  "glossy-milk",
  "midnight",
  "soft-sage",
  "ocean",
  "lavender",
  "warm-sand",
  "high-contrast",
];

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "5S", label: "5 sec" },
  { value: "1", label: "1 min" },
  { value: "2", label: "2 min" },
  { value: "3", label: "3 min" },
  { value: "5", label: "5 min" },
  { value: "10", label: "10 min" },
  { value: "15", label: "15 min" },
  { value: "20", label: "20 min" },
  { value: "30", label: "30 min" },
  { value: "45", label: "45 min" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "180", label: "3 hours" },
  { value: "240", label: "4 hours" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateOffset(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function addCalendarMonths(value: string, months: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  return localDateString(new Date(targetYear, normalizedMonth, Math.min(day, lastDay), 12));
}

function earlierDate(left: string, right: string): string {
  return left < right ? left : right;
}

function showNativeDatePicker(input: HTMLInputElement | null) {
  if (!input) return;
  if (typeof input.showPicker !== "function") {
    input.focus();
    return;
  }
  try {
    input.showPicker();
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "InvalidStateError" || error.name === "NotAllowedError")
    ) {
      input.focus();
      return;
    }
    throw error;
  }
}

function parseContracts(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    throw new Error("Expired contract list is invalid.");
  }
  return value.options.filter(
    (item): item is string =>
      typeof item === "string" && /^(NSE|BSE|MCX):[A-Za-z0-9&_-]+$/.test(item),
  );
}

function parseContractHistories(value: unknown): Record<string, ContractHistory> {
  if (!isRecord(value) || !Array.isArray(value.contracts)) {
    throw new Error("Historical option-chain response is invalid.");
  }
  const histories: Record<string, ContractHistory> = {};
  for (const item of value.contracts) {
    if (!isRecord(item) || typeof item.symbol !== "string") continue;
    histories[item.symbol] = {
      candles: parseCandles(item),
      error:
        typeof item.error === "string"
          ? item.error.replace(/\bfyers\b/gi, "market data service")
          : null,
    };
  }
  return histories;
}

function parseCandles(value: unknown): Candle[] {
  if (!isRecord(value) || !Array.isArray(value.candles)) {
    throw new Error("Historical candle data is invalid.");
  }
  return value.candles.flatMap((item): Candle[] => {
    if (
      !isRecord(item) ||
      typeof item.time !== "number" ||
      !Number.isInteger(item.time) ||
      typeof item.open !== "number" ||
      typeof item.high !== "number" ||
      typeof item.low !== "number" ||
      typeof item.close !== "number" ||
      typeof item.volume !== "number"
    ) {
      return [];
    }
    return [{
      time: item.time as UTCTimestamp,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
      open_interest:
        typeof item.open_interest === "number" ? item.open_interest : null,
    }];
  });
}

function contractsToRows(contracts: string[], expiryDate: string): ContractRow[] {
  const rows = new Map<string, ContractRow>();
  const [year, month, day] = expiryDate.split("-").map(Number);
  const expiryToken =
    String(year).slice(-2) +
    (month < 10 ? String(month) : String(month).padStart(2, "0")) +
    String(day).padStart(2, "0");
  for (const symbol of contracts) {
    const datedMatch = symbol.match(new RegExp(`${expiryToken}(\\d+)(CE|PE)$`));
    const standardMatch = symbol.match(/(\d+)(CE|PE)$/);
    const type = datedMatch?.[2] ?? standardMatch?.[2];
    const strike = datedMatch?.[1] ?? standardMatch?.[1] ?? symbol;
    const row = rows.get(strike) ?? { strike, call: null, put: null };
    if (type === "CE") row.call = symbol;
    else if (type === "PE") row.put = symbol;
    else row.call = symbol;
    rows.set(strike, row);
  }
  return [...rows.values()].sort((left, right) => {
    const leftStrike = Number(left.strike);
    const rightStrike = Number(right.strike);
    if (Number.isFinite(leftStrike) && Number.isFinite(rightStrike)) {
      return leftStrike - rightStrike;
    }
    return left.strike.localeCompare(right.strike);
  });
}

function formatExpiry(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}-${month}-${year}`;
}

function candleAtOrBefore(candles: Candle[], time: number | null): Candle | null {
  const target = time ?? Number.POSITIVE_INFINITY;
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found < 0 ? null : candles[found];
}

const INDIA_TRADING_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function cumulativeSessionVolume(candles: Candle[], selected: Candle): number {
  const selectedDay = INDIA_TRADING_DATE.format(new Date(Number(selected.time) * 1000));
  let total = 0;
  for (const candle of candles) {
    if (candle.time > selected.time) break;
    if (INDIA_TRADING_DATE.format(new Date(Number(candle.time) * 1000)) === selectedDay) {
      total += candle.volume;
    }
  }
  return total;
}

function nearestStrikeRows(
  rows: ContractRow[],
  count: number,
  referencePrice: number | null,
): ContractRow[] {
  if (rows.length === 0) return rows;
  const center =
    referencePrice === null
      ? Math.floor((rows.length - 1) / 2)
      : rows.reduce(
          (nearest, row, index) =>
            Math.abs(Number(row.strike) - referencePrice) <
            Math.abs(Number(rows[nearest].strike) - referencePrice)
              ? index
              : nearest,
          0,
        );
  const sideCount = Math.min(count, center, rows.length - center - 1);
  return rows.slice(center - sideCount, center + sideCount + 1);
}

function spotResolution(resolution: Resolution): SpotResolution {
  return resolution === "5S" ? "1" : resolution;
}

let sessionRefresh: Promise<boolean> | null = null;

async function apiRequest(path: string, options?: RequestInit): Promise<unknown> {
  const makeRequest = () =>
    fetch(path, { ...options, cache: "no-store" });
  let response = await makeRequest();
  if (response.status === 401) {
    if (!sessionRefresh) {
      sessionRefresh = fetch("/api/auth/me", { cache: "no-store" })
        .then((session) => session.ok)
        .finally(() => {
          sessionRefresh = null;
        });
    }
    if (await sessionRefresh) response = await makeRequest();
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.replace("/?returnTo=%2Fhistorical");
    }
    const detail =
      isRecord(body) && typeof body.detail === "string"
        ? body.detail
        : "Unable to load historical market data.";
    throw new Error(detail.replace(/\bfyers\b/gi, "market data service"));
  }
  return body;
}

export default function HistoricalPage() {
  const [symbols, setSymbols] = useState<Underlying[]>([]);
  const [symbol, setSymbol] = useState("");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [symbolMenuOpen, setSymbolMenuOpen] = useState(false);
  const [activeSymbolIndex, setActiveSymbolIndex] = useState(0);
  const [expiryRangeFrom, setExpiryRangeFrom] = useState(() =>
    addCalendarMonths(localDateString(new Date()), -3),
  );
  const [expiryRangeTo, setExpiryRangeTo] = useState(localDateString(new Date()));
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiryCatalog, setExpiryCatalog] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("");
  const [contracts, setContracts] = useState<string[]>([]);
  const [resolution, setResolution] = useState<Resolution>("5");
  const [chainStrikeCount, setChainStrikeCount] = useState(10);
  const [histories, setHistories] = useState<Record<string, ContractHistory>>({});
  const [spotCandles, setSpotCandles] = useState<Candle[]>([]);
  const [chainAnchorPrice, setChainAnchorPrice] = useState<number | null>(null);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [replayActive, setReplayActive] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [loadingSymbols, setLoadingSymbols] = useState(true);
  const [loadingExpiries, setLoadingExpiries] = useState(false);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const expiryFromRef = useRef<HTMLInputElement>(null);
  const expiryToRef = useRef<HTMLInputElement>(null);
  const contractRequestVersion = useRef(0);
  const historyRequestVersion = useRef(0);
  const expiryRequestVersion = useRef(0);

  const clearHistoricalData = useCallback(() => {
    historyRequestVersion.current += 1;
    setHistories({});
    setSpotCandles([]);
    setChainAnchorPrice(null);
    setSelectedTime(null);
    setReplayActive(false);
    setReplayPlaying(false);
    setLoadingCandles(false);
  }, []);

  const contractRows = useMemo(
    () => expiry ? contractsToRows(contracts, expiry) : [],
    [contracts, expiry],
  );
  const filteredSymbols = useMemo(() => {
    const query = symbolSearch.trim().toLocaleLowerCase();
    return query
      ? symbols.filter((item) =>
          `${item.label} ${item.symbol} ${item.type}`.toLocaleLowerCase().includes(query),
        )
      : symbols;
  }, [symbolSearch, symbols]);
  const selectedUnderlying = symbols.find((item) => item.symbol === symbol);
  const historyRangeTo = expiry && expiry < expiryRangeTo ? expiry : expiryRangeTo;
  const minimumHistoryFrom = dateOffset(historyRangeTo, -99);
  const previousExpiry = expiryCatalog
    .filter((item) => item < expiry)
    .at(-1);
  const requestedHistoryFrom = previousExpiry
    ? dateOffset(previousExpiry, 1)
    : expiryRangeFrom;
  const historyRangeFrom =
    requestedHistoryFrom > minimumHistoryFrom
      ? requestedHistoryFrom
      : minimumHistoryFrom;
  const timelineTimes = useMemo(
    () =>
      [...new Set([
        ...spotCandles.map((item) => Number(item.time)),
        ...Object.values(histories).flatMap((history) =>
          history.candles.map((item) => Number(item.time)),
        ),
      ])].sort((left, right) => left - right),
    [histories, spotCandles],
  );
  const replayIndex = Math.max(
    0,
    timelineTimes.findIndex((time) => time === selectedTime),
  );
  const replayTime = selectedTime ?? timelineTimes[timelineTimes.length - 1] ?? null;
  const spotCurrentCandle = candleAtOrBefore(spotCandles, replayTime);
  const visibleStrikeRows = useMemo(
    () =>
      nearestStrikeRows(
        contractRows,
        chainStrikeCount,
        spotCurrentCandle?.close ?? chainAnchorPrice,
      ),
    [chainAnchorPrice, chainStrikeCount, contractRows, spotCurrentCandle?.close],
  );

  useLayoutEffect(() => {
    try {
      const savedTheme = window.localStorage.getItem("optionflow-theme");
      if (savedTheme && THEME_IDS.includes(savedTheme as ThemeId)) {
        document.documentElement.dataset.theme = savedTheme;
        document.cookie = `optionflow-theme=${encodeURIComponent(savedTheme)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }
    } catch (caught) {
      console.error("Unable to restore the selected color theme.", caught);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest("/api/admin/fyers/option-chain/symbols")
      .then((value) => {
        if (!isRecord(value) || !Array.isArray(value.symbols)) {
          throw new Error("Underlying list is invalid.");
        }
        const available = value.symbols.filter(
          (item): item is Underlying =>
            isRecord(item) &&
            typeof item.label === "string" &&
            typeof item.symbol === "string" &&
            typeof item.type === "string",
        );
        if (active) {
          setSymbols(available);
          setSymbol(available[0]?.symbol ?? "");
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Unable to load symbols.");
        }
      })
      .finally(() => {
        if (active) setLoadingSymbols(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!replayPlaying || timelineTimes.length === 0) return;
    const timer = window.setInterval(() => {
      setSelectedTime((current) => {
        const currentIndex = current === null ? 0 : timelineTimes.indexOf(current);
        const nextIndex = Math.min(
          Math.max(currentIndex, 0) + 1,
          timelineTimes.length - 1,
        );
        if (nextIndex >= timelineTimes.length - 1) {
          window.setTimeout(() => setReplayPlaying(false), 0);
        }
        return timelineTimes[nextIndex];
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [replayPlaying, timelineTimes]);

  const selectReplayTime = useCallback(
    (time: number) => {
      let selected = timelineTimes[0];
      for (const candidate of timelineTimes) {
        if (candidate > time) break;
        selected = candidate;
      }
      if (selected !== undefined) {
        setSelectedTime(selected);
        setReplayPlaying(false);
      }
    },
    [timelineTimes],
  );

  async function loadExpiredContracts(
    activeSymbol: string,
    activeExpiry: string,
  ) {
    const version = ++contractRequestVersion.current;
    setError("");
    setNotice("");
    setContracts([]);
    clearHistoricalData();
    setLoadingContracts(true);
    const query = new URLSearchParams({
      symbol: activeSymbol,
      expiry_date: activeExpiry,
    });
    try {
      const available = parseContracts(
        await apiRequest(`/api/admin/fyers/expired/contracts?${query.toString()}`),
      );
      if (version !== contractRequestVersion.current) return;
      setContracts(available);
      if (available.length === 0) {
        setNotice("No expired option contracts were returned for this expiry.");
      } else {
        setLoadingContracts(false);
        await loadContractHistory(available, activeExpiry);
      }
    } catch (caught) {
      if (version === contractRequestVersion.current) {
        setError(caught instanceof Error ? caught.message : "Unable to load contracts.");
      }
    } finally {
      if (version === contractRequestVersion.current) setLoadingContracts(false);
    }
  }

  const loadExpiries = useCallback(async () => {
    if (!symbol || !expiryRangeFrom || !expiryRangeTo) return;
    setError("");
    setNotice("");
    setLoadingExpiries(true);
    setExpiries([]);
    setExpiryCatalog([]);
    setExpiry("");
    setContracts([]);
    clearHistoricalData();
    contractRequestVersion.current += 1;
    setLoadingContracts(false);
    const version = ++expiryRequestVersion.current;
    const query = new URLSearchParams({
      symbol,
      range_from: dateOffset(expiryRangeFrom, -35),
      range_to: expiryRangeTo,
    });
    try {
      const value = await apiRequest(
        `/api/admin/fyers/expired/expiry-dates?${query.toString()}`,
      );
      if (version !== expiryRequestVersion.current) return;
      if (!isRecord(value) || !Array.isArray(value.options)) {
        throw new Error("Expiry date response is invalid.");
      }
      const today = localDateString(new Date());
      const catalog = value.options.filter(
        (item): item is string =>
          typeof item === "string" && item < today && /^\d{4}-\d{2}-\d{2}$/.test(item),
      ).sort();
      const available = catalog.filter(
        (item) => item >= expiryRangeFrom && item <= expiryRangeTo,
      );
      setExpiryCatalog(catalog);
      setExpiries(available);
      const warnings = Array.isArray(value.warnings)
        ? value.warnings.filter(
            (item): item is string => typeof item === "string" && item.length > 0,
          ).map((item) => item.replace(/\bfyers\b/gi, "market data service"))
        : [];
      if (available.length === 0) {
        setNotice(
          ["No expired option expiries were returned for this date range.", ...warnings]
            .join(" "),
        );
      } else if (warnings.length > 0) {
        setNotice(warnings.join(" "));
      }
    } catch (caught) {
      if (version === expiryRequestVersion.current) {
        setError(caught instanceof Error ? caught.message : "Unable to load expiries.");
      }
    } finally {
      if (version === expiryRequestVersion.current) setLoadingExpiries(false);
    }
  }, [clearHistoricalData, expiryRangeFrom, expiryRangeTo, symbol]);

  async function loadContractHistory(
    availableContracts: string[] = contracts,
    activeExpiry: string = expiry,
  ) {
    if (!activeExpiry || availableContracts.length === 0) return;
    setError("");
    setNotice("");
    clearHistoricalData();
    setLoadingCandles(true);
    const version = ++historyRequestVersion.current;
    const expiryRows = contractsToRows(availableContracts, activeExpiry);
    const requestRangeTo =
      activeExpiry < expiryRangeTo ? activeExpiry : expiryRangeTo;
    const requestMinimumFrom = dateOffset(requestRangeTo, -99);
    const precedingExpiry = expiryCatalog
      .filter((item) => item < activeExpiry)
      .at(-1);
    const firstHistoryDate = precedingExpiry
      ? dateOffset(precedingExpiry, 1)
      : expiryRangeFrom;
    const requestRangeFrom =
      firstHistoryDate > requestMinimumFrom
        ? firstHistoryDate
        : requestMinimumFrom;
    const query = new URLSearchParams({
      underlying_symbol: symbol,
      expiry_date: activeExpiry,
      resolution,
      range_from: requestRangeFrom,
      range_to: requestRangeTo,
    });
    const loadedHistories: Record<string, ContractHistory> = {};
    try {
      const spotQuery = new URLSearchParams({
        symbol,
        resolution: spotResolution(resolution),
        range_from: requestRangeFrom,
        range_to: requestRangeTo,
      });
      const spotValue = await apiRequest(`/api/admin/fyers/history?${spotQuery.toString()}`);
      if (version !== historyRequestVersion.current) return;
      const loadedSpot = parseCandles(spotValue);
      const expiryEndTimestamp =
        Date.parse(`${activeExpiry}T23:59:59+05:30`) / 1000;
      const anchorPrice =
        candleAtOrBefore(loadedSpot, expiryEndTimestamp)?.close ??
        loadedSpot[0]?.close ??
        null;
      const rowsToFetch = new Map<string, ContractRow>();
      for (const candle of loadedSpot) {
        for (const row of nearestStrikeRows(
          expiryRows,
          chainStrikeCount,
          candle.close,
        )) {
          rowsToFetch.set(row.strike, row);
        }
      }
      if (rowsToFetch.size === 0) {
        for (const row of nearestStrikeRows(expiryRows, chainStrikeCount, anchorPrice)) {
          rowsToFetch.set(row.strike, row);
        }
      }
      const symbolsToFetch = [...rowsToFetch.values()].flatMap((row) =>
        [row.call, row.put].filter((value): value is string => value !== null),
      );
      const batchSize = 120;
      for (let offset = 0; offset < symbolsToFetch.length; offset += batchSize) {
        if (version !== historyRequestVersion.current) return;
        const batchSymbols = symbolsToFetch.slice(offset, offset + batchSize);
        const chainValue = await apiRequest(
          `/api/admin/fyers/expired/chain-history?${query.toString()}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batchSymbols),
          },
        );
        if (version !== historyRequestVersion.current) return;
        Object.assign(loadedHistories, parseContractHistories(chainValue));
      }
      if (version !== historyRequestVersion.current) return;
      setHistories(loadedHistories);
      setSpotCandles(loadedSpot);
      setChainAnchorPrice(anchorPrice);
      const times = [
        ...loadedSpot.map((item) => Number(item.time)),
        ...Object.values(loadedHistories).flatMap((history) =>
          history.candles.map((item) => Number(item.time)),
        ),
      ];
      setSelectedTime(
        times.length ? times.reduce((latest, time) => Math.max(latest, time)) : null,
      );
      const unavailable = Object.values(loadedHistories).filter(
        (history) => history.error !== null || history.candles.length === 0,
      );
      const notices = [];
      if (loadedSpot.length === 0 && times.length > 0) {
        notices.push(
          "No spot candles were returned; the strike filter is centered on the returned contract list.",
        );
      }
      if (times.length === 0) {
        setNotice("No historical candles were available for this range.");
      } else {
        if (unavailable.length > 0) {
          notices.push(
            `${unavailable.length} of ${symbolsToFetch.length} contracts returned no usable candles.`,
          );
        }
        if (notices.length > 0) {
          setNotice(`${notices.join(" ")} Available data remains visible.`);
        }
      }
    } catch (caught) {
      if (version === historyRequestVersion.current) {
        setError(caught instanceof Error ? caught.message : "Unable to load candles.");
      }
    } finally {
      if (version === historyRequestVersion.current) setLoadingCandles(false);
    }
  }

  function beginReplay() {
    if (timelineTimes.length === 0) return;
    if (replayIndex >= timelineTimes.length - 1) {
      setSelectedTime(timelineTimes[0]);
    }
    setReplayActive(true);
    setReplayPlaying(false);
  }

  function resetExpirySearch() {
    expiryRequestVersion.current += 1;
    contractRequestVersion.current += 1;
    setLoadingExpiries(false);
    setLoadingContracts(false);
    setError("");
    setNotice("");
    setExpiries([]);
    setExpiryCatalog([]);
    setExpiry("");
    setContracts([]);
    clearHistoricalData();
  }

  const intervalName = RESOLUTIONS.find((item) => item.value === resolution)?.label;
  const unavailableCount = Object.values(histories).filter(
    (history) => history.error !== null || history.candles.length === 0,
  ).length;
  const historicalRows = useMemo(
    () =>
      visibleStrikeRows.map((row) => {
        const getLeg = (contract: string | null) => {
          const contractCandles = contract ? histories[contract]?.candles ?? [] : [];
          const candle = candleAtOrBefore(contractCandles, replayTime);
          const candleIndex = candle
            ? contractCandles.findIndex((item) => item.time === candle.time)
            : -1;
          const previousCandle = candleIndex > 0 ? contractCandles[candleIndex - 1] : null;
          return candle
            ? {
                symbol: contract ?? "",
                close: candle.close,
                volume: cumulativeSessionVolume(contractCandles, candle),
                open_interest: candle.open_interest,
                oi_change:
                  candle.open_interest !== null &&
                  previousCandle !== null &&
                  previousCandle.open_interest !== null
                    ? candle.open_interest - previousCandle.open_interest
                    : null,
              }
            : null;
        };
        return {
          strike: row.strike,
          call: getLeg(row.call),
          put: getLeg(row.put),
        };
      }),
    [histories, replayTime, visibleStrikeRows],
  );
  const replayControls = timelineTimes.length > 0 ? (
    <div className={styles.floatingReplayControls}>
      <div className={styles.floatingReplayButtons}>
        {!replayActive ? (
          <button type="button" onClick={beginReplay}>Start replay</button>
        ) : (
          <>
            <button
              type="button"
              disabled={replayIndex <= 0}
              onClick={() => {
                setReplayPlaying(false);
                setSelectedTime(timelineTimes[Math.max(0, replayIndex - 1)]);
              }}
            >‹ Previous</button>
            <button
              type="button"
              disabled={replayIndex >= timelineTimes.length - 1}
              onClick={() => setReplayPlaying((playing) => !playing)}
            >{replayPlaying ? "Pause" : "Play"}</button>
            <button
              type="button"
              disabled={replayIndex >= timelineTimes.length - 1}
              onClick={() => {
                setReplayPlaying(false);
                setSelectedTime(timelineTimes[Math.min(timelineTimes.length - 1, replayIndex + 1)]);
              }}
            >Next ›</button>
            <button
              type="button"
              onClick={() => {
                setReplayPlaying(false);
                setReplayActive(false);
              }}
            >Exit replay</button>
          </>
        )}
      </div>
      <label className={styles.floatingTimeline}>
        <span>{replayActive ? "Replay position" : "Choose replay start"}</span>
        <input
          aria-label="Replay candle"
          type="range"
          min={0}
          max={timelineTimes.length - 1}
          value={replayIndex}
          onChange={(event) => {
            setReplayPlaying(false);
            setSelectedTime(timelineTimes[Number(event.target.value)]);
          }}
        />
        <small>{replayIndex + 1} / {timelineTimes.length}</small>
      </label>
    </div>
  ) : null;

  return (
    <main className={pageStyles.appPage}>
      {symbol && contracts.length > 0 && (
        <SpotChart
          apiRequest={apiRequest}
          underlying={selectedUnderlying ?? null}
          liveTick={null}
          historicalRange={{ from: historyRangeFrom, to: historyRangeTo }}
          historicalCandles={spotCandles}
          historicalResolution={spotResolution(resolution)}
          historicalSelectedTime={selectedTime}
          onHistoricalTimeSelect={selectReplayTime}
          externalReplayControls={replayControls}
          opaque
          forceOpen
        />
      )}
      <div className={`${pageStyles.appShell} ${styles.pageShell}`}>
        <header className={styles.topbar}>
          <Link className={styles.backLink} href="/">← Market Intelligence</Link>
        </header>
        <section className={styles.intro}>
          <p className={styles.kicker}>Expired contracts</p>
          <h1>Historical options &amp; replay</h1>
          <p>
            Choose the underlying and one date range. The expiry dropdown is
            populated from that search. Selecting an expiry automatically loads
            the spot chart and historical option chain at the selected interval.
          </p>
        </section>

        <section className={styles.panel} aria-label="Expired contract selectors">
          <div className={styles.sectionHeading}>
            <div>
              <h2>Find expired options</h2>
              <p>Choose the underlying and date range, then select an expiry.</p>
            </div>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={loadingExpiries || loadingSymbols || !symbol}
              onClick={() => void loadExpiries()}
            >
              {loadingExpiries ? "Finding expiries…" : "Find expiries"}
            </button>
          </div>
          <div className={styles.formGrid}>
            <div className={styles.symbolPicker}>
              <label htmlFor="historical-underlying">Underlying</label>
              <div className={styles.symbolInputWrap}>
                <input
                  id="historical-underlying"
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-expanded={symbolMenuOpen}
                  aria-controls="historical-underlying-options"
                  aria-activedescendant={
                    symbolMenuOpen && filteredSymbols[activeSymbolIndex]
                      ? `historical-symbol-${activeSymbolIndex}`
                      : undefined
                  }
                  placeholder="Search underlying symbols"
                  value={symbolMenuOpen ? symbolSearch : selectedUnderlying?.label ?? ""}
                  disabled={loadingSymbols}
                  onFocus={() => {
                    setSymbolSearch("");
                    setActiveSymbolIndex(0);
                    setSymbolMenuOpen(true);
                  }}
                  onBlur={() => setSymbolMenuOpen(false)}
                  onChange={(event) => {
                    setSymbolSearch(event.target.value);
                    setActiveSymbolIndex(0);
                    setSymbolMenuOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setSymbolMenuOpen(true);
                      setActiveSymbolIndex((index) =>
                        Math.min(index + 1, Math.max(0, filteredSymbols.length - 1)),
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveSymbolIndex((index) => Math.max(index - 1, 0));
                    } else if (event.key === "Enter" && symbolMenuOpen) {
                      event.preventDefault();
                      const choice = filteredSymbols[activeSymbolIndex];
                      if (choice) {
                        setSymbol(choice.symbol);
                        setSymbolSearch("");
                        setSymbolMenuOpen(false);
                        resetExpirySearch();
                      }
                    } else if (event.key === "Escape") {
                      setSymbolSearch("");
                      setSymbolMenuOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.symbolToggle}
                  aria-label={symbolMenuOpen ? "Close underlying symbols" : "Show underlying symbols"}
                  aria-expanded={symbolMenuOpen}
                  disabled={loadingSymbols}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (symbolMenuOpen) {
                      setSymbolSearch("");
                      setSymbolMenuOpen(false);
                    } else {
                      setSymbolSearch("");
                      setActiveSymbolIndex(0);
                      setSymbolMenuOpen(true);
                      document.getElementById("historical-underlying")?.focus();
                    }
                  }}
                >
                  ▾
                </button>
                {symbolMenuOpen && (
                  <div
                    id="historical-underlying-options"
                    className={styles.symbolOptions}
                    role="listbox"
                    aria-label="Underlying symbols"
                  >
                    {filteredSymbols.length ? filteredSymbols.map((item, index) => (
                      <button
                        id={`historical-symbol-${index}`}
                        key={item.symbol}
                        type="button"
                        role="option"
                        aria-selected={item.symbol === symbol}
                        className={item.symbol === symbol ? styles.symbolOptionSelected : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveSymbolIndex(index)}
                        onClick={() => {
                          setSymbol(item.symbol);
                          setSymbolSearch("");
                          setSymbolMenuOpen(false);
                          resetExpirySearch();
                        }}
                      >
                        {item.label} · {item.type}
                      </button>
                    )) : (
                      <span className={styles.noSymbolMatches}>No matching symbols</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <label
              onClick={(event) => {
                if (event.target !== expiryFromRef.current) {
                  showNativeDatePicker(expiryFromRef.current);
                }
              }}
            >
              <span>Date from</span>
              <input
                ref={expiryFromRef}
                type="date"
                value={expiryRangeFrom}
                min={addCalendarMonths(expiryRangeTo, -3)}
                max={expiryRangeTo}
                onClick={() => showNativeDatePicker(expiryFromRef.current)}
                onChange={(event) => {
                  const nextFrom = event.target.value;
                  setExpiryRangeFrom(nextFrom);
                  if (nextFrom) {
                    setExpiryRangeTo(
                      earlierDate(addCalendarMonths(nextFrom, 3), localDateString(new Date())),
                    );
                  }
                  resetExpirySearch();
                }}
              />
            </label>
            <label
              onClick={(event) => {
                if (event.target !== expiryToRef.current) {
                  showNativeDatePicker(expiryToRef.current);
                }
              }}
            >
              <span>Date to</span>
              <input
                ref={expiryToRef}
                type="date"
                value={expiryRangeTo}
                min={expiryRangeFrom}
                max={earlierDate(addCalendarMonths(expiryRangeFrom, 3), localDateString(new Date()))}
                onClick={() => showNativeDatePicker(expiryToRef.current)}
                onChange={(event) => {
                  setExpiryRangeTo(event.target.value);
                  resetExpirySearch();
                }}
              />
            </label>
            <label>
              <span>Interval</span>
              <select
                value={resolution}
                onChange={(event) => {
                  setResolution(event.target.value as Resolution);
                  clearHistoricalData();
                }}
              >
                {RESOLUTIONS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Option-chain strike range</span>
              <select
                value={chainStrikeCount}
                onChange={(event) => {
                  setChainStrikeCount(Number(event.target.value));
                  clearHistoricalData();
                }}
              >
                <option value={5}>5 strikes either side of spot</option>
                <option value={10}>10 strikes either side of spot</option>
                <option value={20}>20 strikes either side of spot</option>
                <option value={29}>Up to 59 strikes (118 contracts)</option>
              </select>
            </label>
            <label>
              <span>Expiry date</span>
              <select
                value={expiry}
                disabled={!expiries.length || loadingExpiries}
                onChange={(event) => {
                  const nextExpiry = event.target.value;
                  setExpiry(nextExpiry);
                  if (nextExpiry) void loadExpiredContracts(symbol, nextExpiry);
                }}
              >
                {!expiries.length && (
                  <option value="">
                    {loadingExpiries
                      ? "Loading expiry dates…"
                      : "Find expiry dates to populate"}
                  </option>
                )}
                {expiries.map((item) => (
                  <option key={item} value={item}>{formatExpiry(item)}</option>
                ))}
              </select>
            </label>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {notice && <p className={styles.notice} role="status">{notice}</p>}
          {expiry && (loadingContracts || contracts.length > 0) && (
            <div className={styles.contractBrowser}>
              <strong>{selectedUnderlying?.label} · {formatExpiry(expiry)}</strong>
              <span>{loadingContracts ? "Loading contracts…" : `${contracts.length} expired option contracts returned`}</span>
            </div>
          )}
        </section>

        <section className={styles.panel} aria-label="Historical chart controls">
          <div className={styles.sectionHeading}>
            <div>
              <h2>Historical spot chart &amp; option chain</h2>
              <p>{selectedUnderlying?.label ?? "Underlying"} · {intervalName}</p>
            </div>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!expiry || !contracts.length || loadingContracts || loadingCandles}
              onClick={() => void loadContractHistory()}
            >
              {loadingCandles ? "Loading spot & option chain…" : "Reload spot & option chain"}
            </button>
          </div>
          <p className={styles.limitNote}>
            Spot and option candles load from {formatExpiry(historyRangeFrom)} –{" "}
            {formatExpiry(historyRangeTo)}, starting the day after the preceding
            expiry where available. The history API limits option data to 100
            days; 5-second option data is limited to the most recent 30 trading
            days. Historical Greeks and bid/ask are not available.
          </p>

          {timelineTimes.length > 0 && (
            <>
              <p className={styles.chartHint}>
                The spot chart and option-chain values share one time cursor.
                During replay, the table updates to each contract candle at or
                before the selected timestamp.
              </p>
              {unavailableCount > 0 && (
                <p className={styles.chartHint}>
                  {unavailableCount} contracts returned no usable candles.
                </p>
              )}
              <HistoricalOptionChain
                apiRequest={apiRequest}
                underlying={selectedUnderlying?.label ?? symbol}
                underlyingSymbol={symbol}
                expiry={formatExpiry(expiry)}
                timestamp={replayTime}
                rows={historicalRows}
                spot={spotCurrentCandle?.close ?? null}
              />
            </>
          )}
          {!error && !notice && timelineTimes.length === 0 && !loadingCandles && (
            <div className={styles.emptyChart}>
              <span aria-hidden="true">◫</span>
              <p>Choose the underlying, date range, interval, and strike range, then select an expiry to load the synced spot chart and option chain.</p>
            </div>
          )}
        </section>
        <footer className={styles.footer}>
          <Link href="/">Return to live option chain</Link>
          <span>Historical candles are loaded on demand.</span>
        </footer>
      </div>
    </main>
  );
}
