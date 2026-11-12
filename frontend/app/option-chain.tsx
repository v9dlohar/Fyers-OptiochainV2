"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./option-chain.module.css";
import SpotChart from "./spot-chart";
import { useLotWisePreference } from "./use-lot-wise-preference";

type ApiRequest = (path: string, options?: RequestInit) => Promise<unknown>;
type Underlying = { label: string; symbol: string; type: string };
type LiveTick = {
  symbol: string;
  ltp: number;
  volume: number | null;
  oi: number | null;
  bid: number | null;
  ask: number | null;
  time: number | null;
  change: number | null;
  changePercent: number | null;
};
type StreamStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
type Expiry = { date: string; timestamp: string; type: string };
type Greeks = {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
};
type OptionLeg = {
  symbol: string;
  type: "CE" | "PE";
  strike: number;
  ltp: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  oi: number | null;
  oiChange: number | null;
  bid: number | null;
  ask: number | null;
  greeks: Greeks | null;
};
type OiBaseline = { oi: number | null; oiChange: number | null };
type Chain = {
  symbol: string;
  expiries: Expiry[];
  selectedExpiry: string | null;
  spot: number | null;
  spotChange: number | null;
  spotChangePercent: number | null;
  callOi: number | null;
  putOi: number | null;
  indiaVix: { ltp: number | null; change: number | null; changePercent: number | null } | null;
  options: OptionLeg[];
  dataStatus: "live" | "stale" | "closed" | "unavailable";
  marketStatus: string | null;
  lastUpdatedAt: string | null;
  dataError: string | null;
};
type StrikeRow = { strike: number; call: OptionLeg | null; put: OptionLeg | null };
type OptionColumn =
  | "oi"
  | "oiChange"
  | "volume"
  | "iv"
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "ltp"
  | "intrinsic"
  | "timeValue";
type ColumnSelection = Record<"call" | "put", Record<OptionColumn, boolean>>;
type RelativeMetric = "oi" | "oiChange" | "volume";
type MetricScale = {
  maximum: number;
  topSymbol: string | null;
  secondSymbol: string | null;
};
type SideShareScales = Record<RelativeMetric, MetricScale>;
type ShareScales = Record<"call" | "put", SideShareScales>;

const STICKY_HEADER_HEIGHT = 74;

const OPTION_COLUMNS: { id: OptionColumn; label: string; title: string }[] = [
  { id: "oi", label: "OI", title: "Open interest and percentage relative to the selected-range maximum" },
  { id: "oiChange", label: "OI Δ", title: "Change in open interest and percentage relative to the selected-range maximum" },
  { id: "volume", label: "Volume", title: "Traded contract volume and percentage relative to the selected-range maximum" },
  { id: "iv", label: "IV %", title: "Provider implied volatility, percent" },
  { id: "delta", label: "Delta", title: "Change in option value for a ₹1 underlying move" },
  { id: "gamma", label: "Gamma", title: "Rate of change of delta" },
  { id: "theta", label: "Theta", title: "Daily time decay" },
  { id: "vega", label: "Vega", title: "Sensitivity to a 1% implied-volatility move" },
  { id: "ltp", label: "LTP", title: "Provider last traded price" },
  { id: "intrinsic", label: "Intrinsic", title: "Intrinsic value using spot and strike" },
  { id: "timeValue", label: "Time value", title: "Provider premium less intrinsic value" },
];

const CALL_COLUMN_ORDER: OptionColumn[] = [
  "iv", "delta", "gamma", "theta", "vega",
  "oiChange", "oi", "volume", "ltp", "intrinsic", "timeValue",
];
const PUT_COLUMN_ORDER: OptionColumn[] = [
  "intrinsic", "timeValue", "ltp", "volume", "oi", "oiChange",
  "iv", "delta", "gamma", "theta", "vega",
];

function defaultColumnSelection(): ColumnSelection {
  const defaults: Record<OptionColumn, boolean> = {
    oi: true,
    oiChange: true,
    volume: true,
    iv: true,
    delta: true,
    gamma: false,
    theta: false,
    vega: false,
    ltp: true,
    intrinsic: false,
    timeValue: false,
  };
  return { call: { ...defaults }, put: { ...defaults } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseChain(value: unknown): Chain {
  if (!isRecord(value) || typeof value.symbol !== "string") {
    throw new Error("The market-data service returned an invalid option chain.");
  }
  const seenContracts = new Set<string>();
  const expiries = Array.isArray(value.expiries)
    ? value.expiries.filter(
        (item): item is Expiry =>
          isRecord(item) &&
          typeof item.date === "string" &&
          typeof item.timestamp === "string" &&
          typeof item.type === "string",
      )
    : [];
  const options: OptionLeg[] = [];
  if (Array.isArray(value.options)) {
    for (const item of value.options) {
      if (!isRecord(item) || (item.type !== "CE" && item.type !== "PE")) continue;
      const strike = finiteNumber(item.strike);
      const contractSymbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
      if (strike === null || !contractSymbol) {
        throw new Error("The market-data service returned an incomplete option contract.");
      }
      const strikeSuffix = `${strike}${item.type}`;
      if (
        !contractSymbol.toUpperCase().endsWith(strikeSuffix)
      ) {
        throw new Error(
          `The contract ${contractSymbol} does not match its reported ${item.type} strike ${formatNumber(strike, 0)}.`,
        );
      }
      const contractKey = `${strike}:${item.type}`;
      if (seenContracts.has(contractKey)) {
        throw new Error(
          `The market-data service returned duplicate ${item.type} contracts for strike ${formatNumber(strike, 0)}.`,
        );
      }
      seenContracts.add(contractKey);
      const rawGreeks = isRecord(item.greeks) ? item.greeks : null;
      options.push({
        symbol: contractSymbol,
        type: item.type,
        strike,
        ltp: finiteNumber(item.ltp),
        change: finiteNumber(item.change),
        changePercent: finiteNumber(item.change_percent),
        volume: finiteNumber(item.volume),
        oi: finiteNumber(item.oi),
        oiChange: finiteNumber(item.oi_change),
        bid: finiteNumber(item.bid),
        ask: finiteNumber(item.ask),
        greeks: rawGreeks
          ? {
              delta: finiteNumber(rawGreeks.delta),
              gamma: finiteNumber(rawGreeks.gamma),
              theta: finiteNumber(rawGreeks.theta),
              vega: finiteNumber(rawGreeks.vega),
              iv: finiteNumber(rawGreeks.iv),
            }
          : null,
      });
    }
  }
  const rawVix = isRecord(value.india_vix) ? value.india_vix : null;
  return {
    symbol: value.symbol,
    expiries,
    selectedExpiry:
      typeof value.selected_expiry === "string" ? value.selected_expiry : null,
    spot: finiteNumber(value.spot),
    spotChange: finiteNumber(value.spot_change),
    spotChangePercent: finiteNumber(value.spot_change_percent),
    callOi: finiteNumber(value.call_oi),
    putOi: finiteNumber(value.put_oi),
    indiaVix: rawVix
      ? {
          ltp: finiteNumber(rawVix.ltp),
          change: finiteNumber(rawVix.change),
          changePercent: finiteNumber(rawVix.change_percent),
        }
      : null,
    options,
    dataStatus:
      value.data_status === "live" ||
      value.data_status === "stale" ||
      value.data_status === "closed" ||
      value.data_status === "unavailable"
        ? value.data_status
        : "unavailable",
    marketStatus:
      typeof value.market_status === "string" ? value.market_status : null,
    lastUpdatedAt:
      typeof value.last_updated_at === "string" ? value.last_updated_at : null,
    dataError: typeof value.data_error === "string" ? value.data_error : null,
  };
}

function parseUnderlyings(value: unknown): Underlying[] {
  if (!isRecord(value) || !Array.isArray(value.symbols)) {
    throw new Error("The underlying list could not be loaded.");
  }
  return value.symbols.filter(
    (item): item is Underlying =>
      isRecord(item) &&
      typeof item.label === "string" &&
      typeof item.symbol === "string" &&
      typeof item.type === "string",
  );
}

function parseLiveTick(value: unknown): LiveTick | null {
  if (
    !isRecord(value) ||
    value.type !== "tick" ||
    typeof value.symbol !== "string" ||
    typeof value.ltp !== "number" ||
    !Number.isFinite(value.ltp)
  ) {
    return null;
  }
  return {
    symbol: value.symbol,
    ltp: value.ltp,
    volume: finiteNumber(value.volume),
    oi: finiteNumber(value.oi),
    bid: finiteNumber(value.bid),
    ask: finiteNumber(value.ask),
    time: finiteNumber(value.time),
    change: finiteNumber(value.change),
    changePercent: finiteNumber(value.change_percent),
  };
}

function adjustedOiChange(leg: OptionLeg, tick: LiveTick, baseline: OiBaseline | undefined): number | null {
  if (
    tick.oi === null ||
    baseline?.oi === null ||
    baseline?.oiChange === null ||
    baseline === undefined
  ) {
    return leg.oiChange;
  }
  return baseline.oiChange + tick.oi - baseline.oi;
}

function formatNumber(value: number | null, digits = 2): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatQuantity(
  value: number | null,
  lotWise = false,
  lotSize: number | null = null,
): string {
  if (value === null) return "—";
  if (lotWise) {
    if (lotSize !== null && lotSize > 0) {
      return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value / lotSize);
    }
  }
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 }).format(value);
}

function signed(value: number | null, digits = 2): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
}

function metricMagnitude(value: number | null, metric: RelativeMetric): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return metric === "oiChange" ? Math.abs(value) : Math.max(value, 0);
}

function metricScale(
  values: { symbol: string; strike: number; magnitude: number }[],
): MetricScale {
  const sorted = values
    .filter((value) => Number.isFinite(value.magnitude))
    .sort(
      (left, right) =>
        right.magnitude - left.magnitude ||
        left.strike - right.strike ||
        left.symbol.localeCompare(right.symbol),
    );
  const top = sorted[0];
  const second = sorted[1];
  return {
    maximum: top?.magnitude ?? 0,
    topSymbol: top?.symbol ?? null,
    secondSymbol: second?.symbol ?? null,
  };
}

function formatShare(
  value: number | null,
  maximum: number,
  signedShare = false,
): string {
  if (value === null) return "—";
  const magnitude = metricMagnitude(value, signedShare ? "oiChange" : "oi");
  if (maximum <= 0) return magnitude === 0 ? (signedShare ? "0.00%" : "0%") : "—";
  const percentage = (magnitude / maximum) * 100;
  const displayedPercentage = signedShare && value < 0 ? -percentage : percentage;
  return `${signedShare ? signed(displayedPercentage) : formatNumber(percentage)}%`;
}

function rankClass(
  value: number | null,
  symbol: string | null,
  scale: MetricScale,
): string {
  if (value === null || symbol === null) return "";
  if (symbol === scale.topSymbol) return styles.topShare;
  if (symbol === scale.secondSymbol) return styles.secondShare;
  return "";
}

function intrinsicValue(type: "CE" | "PE", strike: number, spot: number | null): number | null {
  if (spot === null) return null;
  return Math.max(type === "CE" ? spot - strike : strike - spot, 0);
}

function timeValue(ltp: number | null, intrinsic: number | null): number | null {
  if (ltp === null || intrinsic === null) return null;
  return Math.max(ltp - intrinsic, 0);
}

function renderOptionCell(
  column: OptionColumn,
  leg: OptionLeg | null,
  strike: number,
  spot: number | null,
  type: "CE" | "PE",
  scales: SideShareScales,
  lotWise: boolean,
  lotSizes: Record<string, number | null>,
) {
  const lotSize = leg ? lotSizes[leg.symbol] ?? null : null;
  const displayQuantity = (value: number | null) => formatQuantity(value, lotWise, lotSize);
  const lotTitle = !lotWise
    ? ""
    : lotSize
      ? ` · ${lotSize.toLocaleString("en-IN")} units per lot`
      : " · Lot size unavailable; value shown in units";
  switch (column) {
    case "oi":
      return (
        <td key={column} title={`Open interest: ${formatQuantity(leg?.oi ?? null)}${lotTitle} · relative to selected-range high: ${formatShare(leg?.oi ?? null, scales.oi.maximum)}`}>
          <span className={`${styles.valueWithShare} ${rankClass(leg?.oi ?? null, leg?.symbol ?? null, scales.oi)}`}>
            <span>{displayQuantity(leg?.oi ?? null)}</span>
            <small className={styles.shareBadge}>{formatShare(leg?.oi ?? null, scales.oi.maximum)}</small>
          </span>
        </td>
      );
    case "oiChange":
      return (
        <td
          title={`OI change: ${formatQuantity(leg?.oiChange ?? null)}${lotTitle} · relative to selected-range high by magnitude: ${formatShare(leg?.oiChange ?? null, scales.oiChange.maximum, true)}`}
          key={column}
          className={(leg?.oiChange ?? 0) > 0 ? styles.positive : (leg?.oiChange ?? 0) < 0 ? styles.negative : ""}
        >
          <span className={`${styles.valueWithShare} ${rankClass(leg?.oiChange ?? null, leg?.symbol ?? null, scales.oiChange)}`}>
            <span>{displayQuantity(leg?.oiChange ?? null)}</span>
            <small className={styles.shareBadge}>{formatShare(leg?.oiChange ?? null, scales.oiChange.maximum, true)}</small>
          </span>
        </td>
      );
    case "volume":
      return (
        <td key={column} title={`Volume: ${formatQuantity(leg?.volume ?? null)}${lotTitle} · relative to selected-range high: ${formatShare(leg?.volume ?? null, scales.volume.maximum)}`}>
          <span className={`${styles.valueWithShare} ${rankClass(leg?.volume ?? null, leg?.symbol ?? null, scales.volume)}`}>
            <span>{displayQuantity(leg?.volume ?? null)}</span>
            <small className={styles.shareBadge}>{formatShare(leg?.volume ?? null, scales.volume.maximum)}</small>
          </span>
        </td>
      );
    case "iv":
      return <GreekCell key={column} value={leg?.greeks?.iv ?? null} />;
    case "delta":
      return <GreekCell key={column} value={leg?.greeks?.delta ?? null} />;
    case "gamma":
      return <GreekCell key={column} value={leg?.greeks?.gamma ?? null} />;
    case "theta":
      return <GreekCell key={column} value={leg?.greeks?.theta ?? null} />;
    case "vega":
      return <GreekCell key={column} value={leg?.greeks?.vega ?? null} />;
    case "ltp":
      return (
        <td key={column} className={type === "CE" ? styles.callLtp : styles.putLtp}>
          {formatNumber(leg?.ltp ?? null)}
        </td>
      );
    case "intrinsic":
      return <td key={column}>{formatNumber(intrinsicValue(type, strike, spot))}</td>;
    case "timeValue":
      return (
        <td key={column}>
          {formatNumber(timeValue(leg?.ltp ?? null, intrinsicValue(type, strike, spot)))}
        </td>
      );
  }
}

function SearchableUnderlyingPicker({
  symbols,
  selected,
  onSelect,
}: {
  symbols: Underlying[];
  selected: Underlying | null;
  onSelect: (symbol: Underlying) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return symbols.filter(
      (item) =>
        !query ||
        item.label.toLowerCase().includes(query) ||
        item.symbol.toLowerCase().includes(query),
    );
  }, [search, symbols]);

  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

  return (
    <div className={styles.symbolPicker} ref={container}>
      <button
        type="button"
        className={styles.symbolTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
      >
        <span className={styles.pickerSymbol}>
          {selected?.label ?? "Choose underlying"}
          <small>{selected?.symbol ?? "Symbol"}</small>
        </span>
        <span className={styles.chevron} aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className={styles.symbolMenu}>
          <input
            className={styles.symbolSearch}
            type="search"
            aria-label="Search symbols"
            placeholder="Search name or symbol…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className={styles.symbolList} role="listbox" aria-label="Available underlyings">
            {filtered.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={selected?.symbol === item.symbol}
                key={item.symbol}
                className={styles.symbolOption}
                onClick={() => {
                  onSelect(item);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <span>{item.label}<small>{item.symbol}</small></span>
                <small>{item.type}</small>
              </button>
            ))}
            {filtered.length === 0 && <p className={styles.noSymbols}>No matching symbols.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function GreekCell({ value, digits = 3 }: { value: number | null; digits?: number }) {
  return <td className={styles.greekCell}>{formatNumber(value, digits)}</td>;
}

export default function OptionChainWorkspace({
  apiRequest,
  refreshIntervalSeconds,
}: {
  apiRequest: ApiRequest;
  refreshIntervalSeconds: number;
}) {
  const [symbols, setSymbols] = useState<Underlying[]>([]);
  const [symbol, setSymbol] = useState<Underlying | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [expiry, setExpiry] = useState("");
  const [strikeCount, setStrikeCount] = useState(10);
  const [centerAtmRequest, setCenterAtmRequest] = useState(0);
  const [columns, setColumns] = useState<ColumnSelection>(defaultColumnSelection);
  const [draftColumns, setDraftColumns] = useState<ColumnSelection>(defaultColumnSelection);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [lotWise, setLotWise] = useLotWisePreference();
  const [lotSizes, setLotSizes] = useState<Record<string, number | null>>({});
  const [loadingLotSizes, setLoadingLotSizes] = useState(false);
  const [lotSizeError, setLotSizeError] = useState("");
  const [loadingSymbols, setLoadingSymbols] = useState(true);
  const [loadingChain, setLoadingChain] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("disconnected");
  const [streamWarning, setStreamWarning] = useState("");
  const [liveSpotTick, setLiveSpotTick] = useState<LiveTick | null>(null);
  const [spotLineTop, setSpotLineTop] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [centerStrike, setCenterStrike] = useState<number | null>(null);
  const requestVersion = useRef(0);
  const pendingLiveTicksRef = useRef(new Map<string, LiveTick>());
  const oiBaselinesRef = useRef(new Map<string, OiBaseline>());
  const tableViewportRef = useRef<HTMLDivElement>(null);
  const strikeRowElementsRef = useRef(new Map<number, HTMLTableRowElement>());
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const lastCenteredRequestRef = useRef(0);
  const lotSizeRequestVersion = useRef(0);
  const lotSizesForSymbols = useRef("");

  async function toggleLotWise() {
    if (lotWise) {
      setLotWise(false);
      return;
    }
    if (!chain) return;
    const optionSymbols = [...new Set(chain.options.map((leg) => leg.symbol))];
    const requestVersion = ++lotSizeRequestVersion.current;
    setLoadingLotSizes(true);
    setLotSizeError("");
    try {
      const value = await apiRequest("/api/admin/fyers/option-chain/lot-sizes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(optionSymbols),
      });
      if (!isRecord(value) || !isRecord(value.lot_sizes)) {
        throw new Error("The instrument master returned an invalid lot-size response.");
      }
      const nextSizes: Record<string, number | null> = {};
      for (const optionSymbol of optionSymbols) {
        const lotSize = value.lot_sizes[optionSymbol];
        if (lotSize !== null && (typeof lotSize !== "number" || !Number.isFinite(lotSize) || lotSize <= 0)) {
          throw new Error(`The instrument master returned an invalid lot size for ${optionSymbol}.`);
        }
        nextSizes[optionSymbol] = lotSize;
      }
      if (requestVersion !== lotSizeRequestVersion.current) return;
      setLotSizes(nextSizes);
      lotSizesForSymbols.current = optionSymbols.join(",");
      const missingCount = Object.values(nextSizes).filter((lotSize) => lotSize === null).length;
      if (missingCount > 0) {
        setLotSizeError(
          `Lot sizes are unavailable for ${missingCount} contracts in the current instrument master; those values show as —.`,
        );
      }
      setLotWise(true);
    } catch (caught) {
      if (requestVersion === lotSizeRequestVersion.current) {
        setLotSizeError(
          caught instanceof Error ? caught.message : "Unable to load contract lot sizes.",
        );
      }
    } finally {
      if (requestVersion === lotSizeRequestVersion.current) setLoadingLotSizes(false);
    }
  }

  const loadChain = useCallback(
    async (
      underlying: Underlying,
      selectedExpiry?: string,
      centerAtm = false,
      silent = false,
    ) => {
      const version = ++requestVersion.current;
      if (!silent) {
        setLoadingChain(true);
        setError("");
      }
      const query = new URLSearchParams({ symbol: underlying.symbol });
      if (selectedExpiry) query.set("timestamp", selectedExpiry);
      let loaded = false;
      try {
        const response = parseChain(
          await apiRequest(`/api/admin/fyers/option-chain?${query.toString()}`),
        );
        if (version !== requestVersion.current) return;
        if (response.symbol !== underlying.symbol) {
          throw new Error(
            `The market-data service returned ${response.symbol} while ${underlying.symbol} was requested.`,
          );
        }
        if (selectedExpiry && response.selectedExpiry !== selectedExpiry) {
          throw new Error("The market-data service returned a different option expiry than requested.");
        }
        loaded = true;
        setStreamWarning(
          response.dataStatus === "live"
            ? ""
            : response.dataError
              ? `${response.dataError} Last successful update: ${
                  response.lastUpdatedAt
                    ? new Date(response.lastUpdatedAt).toLocaleTimeString()
                    : "unavailable"
                }.`
              : `Option-chain data is ${response.dataStatus}; last successful update: ${
                  response.lastUpdatedAt
                    ? new Date(response.lastUpdatedAt).toLocaleTimeString()
                    : "unavailable"
                }.`,
        );
        oiBaselinesRef.current = new Map(
          response.options.map((leg) => [
            leg.symbol,
            { oi: leg.oi, oiChange: leg.oiChange },
          ]),
        );
        const result = response;
        if (centerAtm && result.spot !== null && result.options.length > 0) {
          setCenterStrike(
            result.options.reduce((nearest, option) =>
              Math.abs(option.strike - result.spot!) < Math.abs(nearest.strike - result.spot!)
                ? option
                : nearest,
            ).strike,
          );
        }
        setChain(result);
        setExpiry(result.selectedExpiry ?? result.expiries[0]?.timestamp ?? "");
        return result;
      } catch (caught) {
        if (version !== requestVersion.current) return;
        const message = (
          caught instanceof Error ? caught.message : "Unable to load the option chain."
        ).replace(/\bfyers\b/gi, "market data service");
        if (silent) {
          setChain((current) =>
            current
              ? { ...current, dataStatus: "stale", dataError: message }
              : current,
          );
          setStreamWarning(`${message} The displayed option chain may be stale.`);
        } else {
          setError(message);
        }
        return null;
      } finally {
        if (version === requestVersion.current) {
          if (!silent) setLoadingChain(false);
          if (centerAtm && loaded) {
            setCenterAtmRequest((request) => request + 1);
          }
        }
      }
    },
    [apiRequest],
  );

  useEffect(() => {
    let active = true;
    apiRequest("/api/admin/fyers/option-chain/symbols")
      .then(parseUnderlyings)
      .then((items) => {
        if (!active) return;
        setSymbols(items);
        const initialSymbol = items[0] ?? null;
        setSymbol(initialSymbol);
        if (initialSymbol) void loadChain(initialSymbol, undefined, true);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(
            (caught instanceof Error ? caught.message : "Unable to load symbols.")
              .replace(/\bfyers\b/gi, "market data service"),
          );
        }
      })
      .finally(() => {
        if (active) setLoadingSymbols(false);
      });
    return () => {
      active = false;
    };
  }, [apiRequest, loadChain]);

  useEffect(() => {
    if (
      symbol?.symbol !== "NSE:NIFTY50-INDEX" ||
      !chain?.selectedExpiry ||
      expiry !== chain.selectedExpiry
    ) {
      return;
    }

    let active = true;
    let timer = 0;
    const refresh = async () => {
      const requestStartedAt = performance.now();
      const updated = await loadChain(
        symbol,
        chain.selectedExpiry ?? undefined,
        false,
        true,
      );
      if (!active) return;
      const delay = updated?.dataStatus === "closed"
        ? 60_000
        : Math.max(
            0,
            Math.min(5, Math.max(1, refreshIntervalSeconds)) * 1000 -
              (performance.now() - requestStartedAt),
          );
      timer = window.setTimeout(() => void refresh(), delay);
    };
    timer = window.setTimeout(
      () => void refresh(),
      Math.min(5, Math.max(1, refreshIntervalSeconds)) * 1000,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [chain?.selectedExpiry, expiry, loadChain, refreshIntervalSeconds, symbol]);

  const strikeRows = useMemo(() => {
    const rows = new Map<number, StrikeRow>();
    for (const leg of chain?.options ?? []) {
      const row = rows.get(leg.strike) ?? { strike: leg.strike, call: null, put: null };
      if (leg.type === "CE") row.call = leg;
      else row.put = leg;
      rows.set(leg.strike, row);
    }
    return [...rows.values()].sort((a, b) => a.strike - b.strike);
  }, [chain]);
  const chainOptionSymbolsKey = useMemo(
    () => [...new Set((chain?.options ?? []).map((leg) => leg.symbol))].join(","),
    [chain?.options],
  );
  useEffect(() => {
    if (!lotWise || !chainOptionSymbolsKey || lotSizesForSymbols.current === chainOptionSymbolsKey) {
      return;
    }
    const optionSymbols = chainOptionSymbolsKey.split(",");
    const version = ++lotSizeRequestVersion.current;
    void apiRequest("/api/admin/fyers/option-chain/lot-sizes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(optionSymbols),
    }).then((value) => {
      if (version !== lotSizeRequestVersion.current) return;
      if (!isRecord(value) || !isRecord(value.lot_sizes)) {
        throw new Error("The instrument master returned an invalid lot-size response.");
      }
      const nextSizes: Record<string, number | null> = {};
      for (const optionSymbol of optionSymbols) {
        const lotSize = value.lot_sizes[optionSymbol];
        if (lotSize !== null && (typeof lotSize !== "number" || !Number.isFinite(lotSize) || lotSize <= 0)) {
          throw new Error(`The instrument master returned an invalid lot size for ${optionSymbol}.`);
        }
        nextSizes[optionSymbol] = lotSize;
      }
      lotSizesForSymbols.current = chainOptionSymbolsKey;
      setLotSizes(nextSizes);
      const missingCount = Object.values(nextSizes).filter((lotSize) => lotSize === null).length;
      if (missingCount > 0) {
        setLotSizeError(
          `Lot sizes are unavailable for ${missingCount} contracts in the current instrument master; those values remain in units.`,
        );
      }
    }).catch((caught: unknown) => {
      if (version === lotSizeRequestVersion.current) {
        setLotSizeError(
          caught instanceof Error ? caught.message : "Unable to load contract lot sizes.",
        );
      }
    });
  }, [apiRequest, chainOptionSymbolsKey, lotWise]);
  const atmStrike = useMemo(() => {
    if (strikeRows.length === 0) return null;
    if (centerStrike !== null && strikeRows.some((row) => row.strike === centerStrike)) {
      return centerStrike;
    }
    if (chain?.spot === null || chain?.spot === undefined) return null;
    return strikeRows.reduce((nearest, row) =>
      Math.abs(row.strike - chain.spot!) < Math.abs(nearest.strike - chain.spot!)
        ? row
        : nearest,
    ).strike;
  }, [centerStrike, chain, strikeRows]);
  const visibleStrikeRows = useMemo(() => {
    if (atmStrike === null || strikeRows.length === 0) return strikeRows;
    const center = strikeRows.findIndex((row) => row.strike === atmStrike);
    return strikeRows.slice(
      Math.max(0, center - strikeCount),
      Math.min(strikeRows.length, center + strikeCount + 1),
    );
  }, [atmStrike, strikeCount, strikeRows]);
  const updateSpotLinePosition = useCallback(() => {
    const viewport = tableViewportRef.current;
    const spot = chain?.spot;
    if (spot === null || spot === undefined || !viewport || visibleStrikeRows.length === 0) {
      setSpotLineTop(null);
      return;
    }
    const viewportBounds = viewport.getBoundingClientRect();
    const centerOf = (strike: number): number | null => {
      const element = strikeRowElementsRef.current.get(strike);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return (
        bounds.top -
        viewportBounds.top +
        viewport.scrollTop -
        viewport.clientTop +
        bounds.height / 2
      );
    };
    if (spot < visibleStrikeRows[0].strike) {
      setSpotLineTop(centerOf(visibleStrikeRows[0].strike));
      return;
    }
    if (spot > visibleStrikeRows[visibleStrikeRows.length - 1].strike) {
      setSpotLineTop(centerOf(visibleStrikeRows[visibleStrikeRows.length - 1].strike));
      return;
    }
    const upperIndex = visibleStrikeRows.findIndex((row) => row.strike >= spot);
    if (upperIndex < 0) {
      setSpotLineTop(null);
      return;
    }

    const upperRow = visibleStrikeRows[upperIndex];
    const upperCenter = centerOf(upperRow.strike);
    if (upperCenter === null) {
      setSpotLineTop(null);
      return;
    }
    if (upperRow.strike === spot || upperIndex === 0) {
      setSpotLineTop(upperCenter);
      return;
    }

    const lowerRow = visibleStrikeRows[upperIndex - 1];
    const lowerCenter = centerOf(lowerRow.strike);
    if (lowerCenter === null || upperRow.strike === lowerRow.strike) {
      setSpotLineTop(null);
      return;
    }
    const fraction = (spot - lowerRow.strike) / (upperRow.strike - lowerRow.strike);
    setSpotLineTop(lowerCenter + (upperCenter - lowerCenter) * fraction);
  }, [chain?.spot, visibleStrikeRows]);
  const streamSymbols = useMemo(() => {
    if (!symbol) return [];
    const optionSymbols = visibleStrikeRows
      .flatMap((row) => [row.call?.symbol, row.put?.symbol])
      .filter((item): item is string => item !== undefined);
    optionSymbols.sort((left, right) => {
      const leftLeg = chain?.options.find((leg) => leg.symbol === left);
      const rightLeg = chain?.options.find((leg) => leg.symbol === right);
      return Math.abs((leftLeg?.strike ?? atmStrike ?? 0) - (atmStrike ?? 0))
        - Math.abs((rightLeg?.strike ?? atmStrike ?? 0) - (atmStrike ?? 0));
    });
    return [...new Set([symbol.symbol, ...optionSymbols.slice(0, 199)])];
  }, [atmStrike, chain?.options, symbol, visibleStrikeRows]);
  const hasChain = chain !== null && chain.selectedExpiry === expiry;
  const isSharedDefaultNifty =
    symbol?.symbol === "NSE:NIFTY50-INDEX" &&
    hasChain &&
    chain.expiries[0]?.timestamp === chain.selectedExpiry;
  const streamSymbolsKey = streamSymbols.join(",");
  const streamSymbolsRef = useRef<string[]>(streamSymbols);

  useEffect(() => {
    if (!symbol || !expiry || !hasChain) return;
    if (isSharedDefaultNifty) {
      pendingLiveTicksRef.current.clear();
      return;
    }
    const selectedSymbol = symbol;
    let cancelled = false;
    let reconnectTimer = 0;
    let tickTimer = 0;
    let heartbeatTimer = 0;
    let reconnectDelay = 3000;
    let socket: WebSocket | null = null;
    const pendingTicks = pendingLiveTicksRef.current;

    function flushLiveTicks() {
      tickTimer = 0;
      const ticks = [...pendingTicks.values()];
      pendingTicks.clear();
      if (ticks.length === 0) return;

      const ticksBySymbol = new Map(ticks.map((tick) => [tick.symbol, tick]));
      const spotTick = ticksBySymbol.get(selectedSymbol.symbol);
      if (spotTick) setLiveSpotTick(spotTick);
      setChain((current) => {
        if (!current) return current;
        const currentSpotTick = ticksBySymbol.get(current.symbol);
        let optionsChanged = false;
        const options = current.options.map((leg) => {
          const tick = ticksBySymbol.get(leg.symbol);
          if (!tick) return leg;
          optionsChanged = true;
          return {
            ...leg,
            ltp: tick.ltp,
            change: tick.change ?? leg.change,
            changePercent: tick.changePercent ?? leg.changePercent,
            volume: tick.volume ?? leg.volume,
            oi: tick.oi ?? leg.oi,
            oiChange: adjustedOiChange(
              leg,
              tick,
              oiBaselinesRef.current.get(leg.symbol),
            ),
            bid: tick.bid ?? leg.bid,
            ask: tick.ask ?? leg.ask,
          };
        });
        if (!currentSpotTick && !optionsChanged) return current;
        return {
          ...current,
          spot: currentSpotTick?.ltp ?? current.spot,
          spotChange: currentSpotTick?.change ?? current.spotChange,
          spotChangePercent: currentSpotTick?.changePercent ?? current.spotChangePercent,
          options: optionsChanged ? options : current.options,
        };
      });
    }
    function scheduleReconnect() {
      reconnectTimer = window.setTimeout(() => void connectStream(), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }

    async function connectStream() {
      setStreamStatus("connecting");
      try {
        const ticketPayload: unknown = await apiRequest("/api/admin/fyers/stream-ticket", {
          method: "POST",
          cache: "no-store",
        });
        if (
          !isRecord(ticketPayload) ||
          typeof ticketPayload.ticket !== "string"
        ) {
          throw new Error("Live market stream authorization failed.");
        }
        if (cancelled) return;

        const url = process.env.NEXT_PUBLIC_API_WS_URL
          ?? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:8000/admin/fyers/stream`;
        socket = new WebSocket(url);
        streamSocketRef.current = socket;
        socket.onopen = () => {
          socket?.send(JSON.stringify({
            ticket: ticketPayload.ticket,
            symbol: selectedSymbol.symbol,
            timestamp: expiry,
            symbols: streamSymbolsRef.current,
          }));
          heartbeatTimer = window.setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "ping" }));
            }
          }, 25_000);
        };
        socket.onmessage = (event) => {
          let message: unknown;
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (isRecord(message) && message.type === "status") {
            if (
              message.status === "connected" ||
              message.status === "reconnecting" ||
              message.status === "connecting"
            ) {
              setStreamStatus(message.status);
              if (message.status === "connected") reconnectDelay = 3000;
            }
            return;
          }
          if (isRecord(message) && message.type === "error") {
            setStreamStatus("error");
            socket?.close();
            return;
          }
          if (isRecord(message) && message.type === "warning") {
            setStreamWarning(
              typeof message.message === "string"
                ? message.message
                : "Some live option updates failed validation; keeping the last valid values.",
            );
            return;
          }
          const tick = parseLiveTick(message);
          if (!tick) return;
          pendingTicks.set(tick.symbol, tick);
          if (!tickTimer) {
            tickTimer = window.setTimeout(flushLiveTicks, 250);
          }
        };
        socket.onerror = () => setStreamStatus("error");
        socket.onclose = () => {
          window.clearInterval(heartbeatTimer);
          if (streamSocketRef.current === socket) streamSocketRef.current = null;
          pendingTicks.clear();
          if (cancelled) return;
          setStreamStatus("reconnecting");
          scheduleReconnect();
        };
      } catch {
        if (cancelled) return;
        setStreamStatus("reconnecting");
        scheduleReconnect();
      }
    }

    void connectStream();
    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(tickTimer);
      window.clearInterval(heartbeatTimer);
      pendingTicks.clear();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      if (streamSocketRef.current === socket) streamSocketRef.current = null;
    };
  }, [apiRequest, expiry, hasChain, isSharedDefaultNifty, symbol]);

  useEffect(() => {
    streamSymbolsRef.current = streamSymbolsKey ? streamSymbolsKey.split(",") : [];
    const socket = streamSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "subscribe",
        symbols: streamSymbolsRef.current,
      }));
    }
  }, [streamSymbolsKey]);

  const shareScales = useMemo<ShareScales>(() => {
    const scalesForSide = (side: "call" | "put"): SideShareScales =>
      (["oi", "oiChange", "volume"] as const).reduce(
        (scales, metric) => {
          scales[metric] = metricScale(
            visibleStrikeRows.flatMap((row) => {
              const leg = row[side];
              if (!leg) return [];
              const value = leg[metric];
              return value === null
                ? []
                : [{
                    symbol: leg.symbol,
                    strike: row.strike,
                    magnitude: metricMagnitude(value, metric),
                  }];
            }),
          );
          return scales;
        },
        {
          oi: metricScale([]),
          oiChange: metricScale([]),
          volume: metricScale([]),
        },
      );

    return {
      call: scalesForSide("call"),
      put: scalesForSide("put"),
    };
  }, [visibleStrikeRows]);
  const selectedExpiry = chain?.expiries.find((item) => item.timestamp === chain.selectedExpiry);
  const displayedUnderlying = symbols.find((item) => item.symbol === chain?.symbol) ?? symbol;
  const visibleCallColumns = CALL_COLUMN_ORDER
    .filter((id) => columns.call[id])
    .map((id) => OPTION_COLUMNS.find((column) => column.id === id)!);
  const visiblePutColumns = PUT_COLUMN_ORDER
    .filter((id) => columns.put[id])
    .map((id) => OPTION_COLUMNS.find((column) => column.id === id)!);
  useEffect(() => {
    const viewport = tableViewportRef.current;
    const atmRow = atmRowRef.current;
    if (
      loadingChain ||
      centerAtmRequest === lastCenteredRequestRef.current ||
      !hasChain ||
      atmStrike === null ||
      !viewport ||
      !atmRow
    ) return;
    lastCenteredRequestRef.current = centerAtmRequest;

    const frame = window.requestAnimationFrame(() => {
      const viewportRect = viewport.getBoundingClientRect();
      const rowRect = atmRow.getBoundingClientRect();
      const stickyHeaderHeight = STICKY_HEADER_HEIGHT;
      const visibleHeight = Math.max(viewport.clientHeight - stickyHeaderHeight, 0);
      const rowTop = viewport.scrollTop + rowRect.top - viewportRect.top;
      const targetTop = rowTop - stickyHeaderHeight -
        Math.max((visibleHeight - atmRow.offsetHeight) / 2, 0);

      viewport.scrollTo({
        top: Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, targetTop)),
        behavior: "instant",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [atmStrike, centerAtmRequest, chain, hasChain, loadingChain, strikeCount, visibleStrikeRows]);

  useEffect(() => {
    const viewport = tableViewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const schedulePositionUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateSpotLinePosition);
    };
    const observer = new ResizeObserver(schedulePositionUpdate);
    observer.observe(viewport);
    window.addEventListener("resize", schedulePositionUpdate);
    schedulePositionUpdate();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedulePositionUpdate);
      window.cancelAnimationFrame(frame);
    };
  }, [updateSpotLinePosition]);

  return (
    <section className={styles.workspace} aria-label="Options chain">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.kicker}>Market overview</p>
          <h2>Options chain</h2>
        </div>
      </div>
      <div className={styles.controlBar}>
        <label className={styles.control}>
          <span>Underlying</span>
          {loadingSymbols ? (
            <div className={styles.controlLoading}>Loading symbols…</div>
          ) : (
            <SearchableUnderlyingPicker
              symbols={symbols}
              selected={symbol}
              onSelect={(next) => {
                lotSizeRequestVersion.current += 1;
                lotSizesForSymbols.current = "";
                setLotSizes({});
                setLotSizeError("");
                setExpiry("");
                setSymbol(next);
                void loadChain(next, undefined, true);
              }}
            />
          )}
        </label>
        <label className={styles.control}>
          <span>Expiry date</span>
          <select
            value={expiry}
            disabled={!chain?.expiries.length || loadingChain}
            onChange={(event) => {
              const next = event.target.value;
              lotSizeRequestVersion.current += 1;
              lotSizesForSymbols.current = "";
              setLotSizes({});
              setLotSizeError("");
              setExpiry(next);
              if (symbol) void loadChain(symbol, next, true);
            }}
          >
            {!chain?.expiries.length && <option value="">Waiting for expiries…</option>}
            {chain?.expiries.map((item) => (
              <option value={item.timestamp} key={item.timestamp}>
                {item.date}{item.type === "W" ? " · Weekly" : item.type === "M" ? " · Monthly" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span>Strike range</span>
          <select
            value={strikeCount}
            onChange={(event) => {
              const nextCount = Number(event.target.value);
              setStrikeCount(nextCount);
            }}
          >
            <option value={5}>5 strikes either side</option>
            <option value={10}>10 strikes either side</option>
            <option value={20}>20 strikes either side</option>
            <option value={30}>30 strikes either side</option>
            <option value={50}>All available (up to 50 either side)</option>
          </select>
        </label>
      </div>

      {error && <div className={styles.errorBanner} role="alert">{error}</div>}

      <section className={styles.chainPanel} id="option-chain-table" aria-label="Option chain data">
      <div className={styles.chainStatusBar}>
        <button
          className={styles.refreshButton}
          type="button"
          disabled={!symbol || loadingChain}
          title={isSharedDefaultNifty
            ? "Reload the shared server snapshot. It refreshes at the configured interval."
            : "Reload the server snapshot. Contract price updates also arrive over the backend market stream."}
          onClick={() => symbol && void loadChain(symbol, expiry || undefined)}
        >
          <span aria-hidden="true">↻</span> {loadingChain ? "Updating…" : "Refresh chain"}
        </button>
        {isSharedDefaultNifty ? (
          <span className={`${styles.streamStatus} ${styles.streamStatus_connected}`} role="status">
            <span aria-hidden="true" />
            Server snapshot every {Math.min(5, Math.max(1, refreshIntervalSeconds))}s
          </span>
        ) : streamStatus !== "disconnected" && (
          <span className={`${styles.streamStatus} ${styles[`streamStatus_${streamStatus}`]}`} aria-live="polite">
            <span aria-hidden="true" />
            {streamStatus === "connected"
              ? "Live feed connected"
              : streamStatus === "connecting"
                ? "Connecting live feed…"
                : streamStatus === "reconnecting"
                  ? "Reconnecting live feed…"
                  : "Live updates unavailable"}
          </span>
        )}
        {streamWarning && (
          <span className={styles.streamWarning} role="status">{streamWarning}</span>
        )}
        {chain && (
          <span
            className={chain.dataStatus === "live" ? styles.streamStatus_connected : styles.streamWarning}
            role="status"
          >
            Server chain {chain.dataStatus}
            {chain.lastUpdatedAt
              ? ` · ${new Date(chain.lastUpdatedAt).toLocaleTimeString()}`
              : ""}
          </span>
        )}
      </div>
      <div className={styles.tableHeader}>
        <div>
          <h3>{displayedUnderlying?.label ?? "Option contracts"} option chain</h3>
          <span>{chain?.symbol ?? symbol?.symbol} · {selectedExpiry?.date ?? "Expiry loading"}</span>
        </div>
        <div className={styles.tableActions}>
          {chain && <span className={styles.strikeCount}>{visibleStrikeRows.length} strikes shown</span>}
          <button
            type="button"
            className={styles.lotModeButton}
            aria-pressed={lotWise}
            disabled={!chain || chain.options.length === 0 || loadingLotSizes}
            title="Show Volume, OI and OI change in lots using each option contract's lot size"
            onClick={() => void toggleLotWise()}
          >
            <span>{loadingLotSizes ? "Loading…" : lotWise ? "Lot-wise" : "Units"}</span>
            <span className={styles.lotSwitch} aria-hidden="true" />
          </button>
          <div className={styles.columnSettings}>
            <button
              type="button"
              className={styles.columnSettingsButton}
              aria-expanded={columnSettingsOpen}
              aria-controls="option-column-settings"
              onClick={() => {
                if (!columnSettingsOpen) setDraftColumns(columns);
                setColumnSettingsOpen((open) => !open);
              }}
            >
              Columns <span aria-hidden="true">▤</span>
            </button>
            {columnSettingsOpen && (
              <div className={styles.columnPopover} id="option-column-settings">
                <div className={styles.columnPopoverHeading}>
                  <strong>Visible columns</strong>
                  <button type="button" onClick={() => setColumnSettingsOpen(false)} aria-label="Close column settings">×</button>
                </div>
                {(["call", "put"] as const).map((side) => (
                  <fieldset className={styles.columnFieldset} key={side}>
                    <legend>{side === "call" ? "Calls (CE)" : "Puts (PE)"}</legend>
                    {OPTION_COLUMNS.map((column) => (
                      <label key={column.id}>
                        <input
                          type="checkbox"
                          checked={draftColumns[side][column.id]}
                          disabled={
                            draftColumns[side][column.id] &&
                            Object.values(draftColumns[side]).filter(Boolean).length === 1
                          }
                          onChange={(event) =>
                            setDraftColumns((current) => ({
                              ...current,
                              [side]: {
                                ...current[side],
                                [column.id]: event.target.checked,
                              },
                            }))
                          }
                        />
                        {column.label}
                      </label>
                    ))}
                  </fieldset>
                ))}
                <div className={styles.columnPopoverActions}>
                  <button
                    type="button"
                    className={styles.resetColumnsButton}
                    onClick={() => setDraftColumns(defaultColumnSelection())}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className={styles.applyColumnsButton}
                    onClick={() => {
                      setColumns(draftColumns);
                      setColumnSettingsOpen(false);
                    }}
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {lotSizeError && <p className={styles.lotSizeNotice} role="status">{lotSizeError}</p>}
      <div className={styles.scrollHint}>
        {chain?.spot !== null && chain?.spot !== undefined && (
          <span className={styles.spotLegend}><i /> Current underlying LTP {formatNumber(chain.spot)}</span>
        )}
      </div>
      <div
        ref={tableViewportRef}
        className={styles.tableViewport}
        aria-busy={loadingChain}
        role="region"
        aria-label="Scrollable option chain table"
        tabIndex={0}
        onScroll={updateSpotLinePosition}
      >
        {spotLineTop !== null && (
            <div className={styles.spotPriceLine} style={{ top: spotLineTop }}>
              <span>{`SPOT ${formatNumber(chain?.spot ?? null)}`}</span>
            </div>
          )}
        {!chain && loadingChain && <div className={styles.tableLoading}>Fetching option chain and Greeks…</div>}
        {chain && visibleStrikeRows.length > 0 && (
          <table className={styles.chainTable}>
            <thead>
              <tr className={styles.groupHeader}>
                <th className={styles.callGroupHeader} colSpan={visibleCallColumns.length}>CALLS <small>CE</small></th>
                <th rowSpan={2} className={styles.strikeHeader}>STRIKE</th>
                <th className={styles.putGroupHeader} colSpan={visiblePutColumns.length}>PUTS <small>PE</small></th>
              </tr>
              <tr className={styles.columnHeader}>
                {visibleCallColumns.map((column) => <th className={styles.callColumnHeader} key={column.id} title={column.title}>{column.label}</th>)}
                {visiblePutColumns.map((column) => <th className={styles.putColumnHeader} key={column.id} title={column.title}>{column.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {visibleStrikeRows.map((row) => (
                <Fragment key={row.strike}>
                  <tr
                    ref={(element) => {
                      if (row.strike === atmStrike) atmRowRef.current = element;
                      if (element) strikeRowElementsRef.current.set(row.strike, element);
                      else strikeRowElementsRef.current.delete(row.strike);
                    }}
                    className={row.strike === atmStrike ? styles.atmRow : undefined}
                  >
                    {visibleCallColumns.map((column) => (
                      <Fragment key={`call-${column.id}`}>
                        {renderOptionCell(
                          column.id,
                          row.call,
                          row.strike,
                          chain?.spot ?? null,
                          "CE",
                          shareScales.call,
                          lotWise,
                          lotSizes,
                        )}
                      </Fragment>
                    ))}
                    <td className={styles.strikeCell}>
                      {formatNumber(row.strike, 0)}
                      {row.strike === atmStrike && <small>ATM</small>}
                    </td>
                    {visiblePutColumns.map((column) => (
                      <Fragment key={`put-${column.id}`}>
                        {renderOptionCell(
                          column.id,
                          row.put,
                          row.strike,
                          chain?.spot ?? null,
                          "PE",
                          shareScales.put,
                          lotWise,
                          lotSizes,
                        )}
                      </Fragment>
                    ))}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {chain && !loadingChain && visibleStrikeRows.length === 0 && (
          <div className={styles.emptyState}>No option contracts are available for this expiry.</div>
        )}
        {!loadingChain && !chain && !error && (
          <div className={styles.emptyState}>Choose an underlying to load its option chain.</div>
        )}
      </div>
      </section>
      <SpotChart
        key={symbol?.symbol ?? "no-underlying"}
        apiRequest={apiRequest}
        underlying={symbol}
        liveTick={isSharedDefaultNifty ? null : liveSpotTick}
      />
    </section>
  );
}
