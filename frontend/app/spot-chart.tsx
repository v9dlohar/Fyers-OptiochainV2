"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type TickMarkFormatter,
  type TimeFormatterFn,
  type UTCTimestamp,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import styles from "./spot-chart.module.css";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

type ApiRequest = (path: string, options?: RequestInit) => Promise<unknown>;
type Underlying = { label: string; symbol: string; type: string };
type LiveTick = {
  symbol: string;
  ltp: number;
  volume: number | null;
  time: number | null;
  change: number | null;
};
type Resolution =
  | "1"
  | "2"
  | "3"
  | "5"
  | "10"
  | "15"
  | "20"
  | "30"
  | "45"
  | "60"
  | "120"
  | "180"
  | "240"
  | "D";
type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type DrawingTool =
  | "cursor"
  | "horizontal"
  | "ray"
  | "trend"
  | "vertical"
  | "rectangle"
  | "fibonacci";
type DrawingKind = Exclude<DrawingTool, "cursor">;
type DrawingPoint = { time: number; price: number };
type ChartDrawing = {
  id: number;
  tool: DrawingKind;
  start: DrawingPoint;
  end?: DrawingPoint;
};
type FloatingPosition = { left: number; top: number } | null;
type FloatingSize = { width: number; height: number } | null;
type FloatingResizeAxis = "both" | "height";

const EMPTY_CANDLES: Candle[] = [];
const EMPTY_DRAWINGS: ChartDrawing[] = [];
const DRAWING_STORAGE_KEY = "optionflow.chart.drawings";
const POSITION_STORAGE_KEY = "optionflow.chart.position";
const VISIBILITY_STORAGE_KEY = "optionflow.chart.visible";
const MIN_FLOATING_HEIGHT = 280;

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "1", label: "1m" },
  { value: "5", label: "5m" },
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "60", label: "1h" },
  { value: "D", label: "1D" },
];
const FIBONACCI_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
const INDIA_TIME_ZONE = "Asia/Kolkata";

function chartTimeDate(time: Time): Date {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") return new Date(`${time}T00:00:00+05:30`);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

function liveCandleStart(timestamp: number, resolution: Resolution): UTCTimestamp {
  if (resolution === "D") {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: INDIA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp * 1000));
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "1970";
    return Date.UTC(
      Number(part("year")),
      Number(part("month")) - 1,
      Number(part("day")),
      3,
      45,
    ) / 1000 as UTCTimestamp;
  }
  const interval = Number(resolution) * 60;
  const indiaOffset = 5 * 60 * 60 + 30 * 60;
  const bucket = Math.floor((timestamp + indiaOffset) / interval) * interval - indiaOffset;
  return bucket as UTCTimestamp;
}

function formatIndiaTime(time: Time, withDate: boolean): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    day: withDate ? "2-digit" : undefined,
    month: withDate ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(chartTimeDate(time));
}

function formatCrosshairDateTime(time: Time): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(chartTimeDate(time));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    }];
  });
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatVolume(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function drawingCoordinates(
  chart: IChartApi | null,
  series: ISeriesApi<"Candlestick"> | null,
  drawing: ChartDrawing,
  candles: Candle[],
) {
  if (!chart || !series) return null;
  const startTime = candleTimeAtOrBefore(candles, drawing.start.time);
  if (startTime === null) return null;
  const startX = chart.timeScale().timeToCoordinate(startTime);
  const startY = series.priceToCoordinate(drawing.start.price);
  if (startX === null || startY === null) return null;
  const endTime = drawing.end ? candleTimeAtOrBefore(candles, drawing.end.time) : null;
  const endX = endTime === null ? null : chart.timeScale().timeToCoordinate(endTime);
  const endY = drawing.end ? series.priceToCoordinate(drawing.end.price) : null;
  return { startX, startY, endX, endY };
}

function candleTimeAtOrBefore(candles: Candle[], timestamp: number): UTCTimestamp | null {
  if (candles.length === 0) return null;
  let candidate = candles[0].time;
  for (const candle of candles) {
    if (candle.time > timestamp) break;
    candidate = candle.time;
  }
  return candidate;
}

function candleIndexAtOrBefore(candles: Candle[], timestamp: number): number | null {
  if (candles.length === 0) return null;
  let index = 0;
  for (let current = 0; current < candles.length; current += 1) {
    if (candles[current].time > timestamp) break;
    index = current;
  }
  return index;
}

function readSavedDrawings(symbol: string): ChartDrawing[] {
  try {
    const stored = window.localStorage.getItem(DRAWING_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || !Array.isArray(parsed[symbol])) return [];
    return parsed[symbol].filter((item): item is ChartDrawing => {
      if (!isRecord(item) || !isRecord(item.start)) return false;
      if (
        typeof item.id !== "number" ||
        !Number.isInteger(item.id) ||
        !["horizontal", "ray", "trend", "vertical", "rectangle", "fibonacci"].includes(
          String(item.tool),
        ) ||
        typeof item.start.time !== "number" ||
        typeof item.start.price !== "number"
      ) return false;
      return item.end === undefined || (
        isRecord(item.end) &&
        typeof item.end.time === "number" &&
        typeof item.end.price === "number"
      );
    });
  } catch {
    return [];
  }
}

function saveDrawings(symbol: string, drawings: ChartDrawing[]) {
  try {
    const stored = window.localStorage.getItem(DRAWING_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    const allDrawings = isRecord(parsed) ? parsed : {};
    window.localStorage.setItem(
      DRAWING_STORAGE_KEY,
      JSON.stringify({ ...allDrawings, [symbol]: drawings }),
    );
  } catch {
    // Browser storage can be unavailable or full; keep drawings available for this session.
  }
}

export default function SpotChart({
  apiRequest,
  underlying,
  liveTick,
  historicalRange,
  historicalCandles,
  historicalResolution,
  historicalSelectedTime,
  onHistoricalTimeSelect,
  externalReplayControls,
  opaque = false,
  forceOpen = false,
}: {
  apiRequest: ApiRequest;
  underlying: Underlying | null;
  liveTick: LiveTick | null;
  historicalRange?: { from: string; to: string };
  historicalCandles?: Candle[];
  historicalResolution?: Resolution;
  historicalSelectedTime?: number | null;
  onHistoricalTimeSelect?: (time: number) => void;
  externalReplayControls?: ReactNode;
  opaque?: boolean;
  forceOpen?: boolean;
}) {
  const [resolution, setResolution] = useState<Resolution>(historicalResolution ?? "5");
  const [history, setHistory] = useState<{
    key: string;
    candles: Candle[];
    error: string;
  } | null>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool>("cursor");
  const [storedDrawings, setStoredDrawings] = useState<{
    symbol: string;
    drawings: ChartDrawing[];
  } | null>(null);
  const [drawingDrag, setDrawingDrag] = useState<{
    drawing: ChartDrawing;
    pointer: DrawingPoint;
  } | null>(null);
  const [drawingDragPreview, setDrawingDragPreview] = useState<DrawingPoint | null>(null);
  const [pendingDrawing, setPendingDrawing] = useState<ChartDrawing | null>(null);
  const [pointerPoint, setPointerPoint] = useState<DrawingPoint | null>(null);
  const [viewRevision, setViewRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [replayActive, setReplayActive] = useState(false);
  const [replayTime, setReplayTime] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition>(null);
  const [floatingSize, setFloatingSize] = useState<FloatingSize>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [chartPreferencesLoaded, setChartPreferencesLoaded] = useState(false);
  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [candleSeries, setCandleSeries] = useState<ISeriesApi<"Candlestick"> | null>(null);
  const [chartDimensions, setChartDimensions] = useState({ width: 0, height: 0 });
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const crosshairTimeRef = useRef<HTMLDivElement>(null);
  const chartShellRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const requestVersion = useRef(0);
  const drawingId = useRef(0);
  const drawingRefreshFrame = useRef(0);
  const dragStart = useRef<{ pointerX: number; pointerY: number; left: number; top: number } | null>(null);
  const floatingPointer = useRef<{ x: number; y: number } | null>(null);
  const floatingFrame = useRef(0);
  const userAdjustedChart = useRef(false);
  const chartCardRef = useRef<HTMLElement>(null);
  const liveCandleRef = useRef<Candle | null>(null);
  const cumulativeVolumeRef = useRef<number | null>(null);
  const activeResolution = historicalResolution ?? resolution;
  const historicalFrom = historicalRange?.from;
  const historicalTo = historicalRange?.to;
  const requestKey = `${underlying?.symbol ?? ""}:${activeResolution}:${historicalFrom ?? ""}:${historicalTo ?? ""}`;
  const underlyingSymbol = underlying?.symbol;
  const drawings = storedDrawings && storedDrawings.symbol === underlyingSymbol
    ? storedDrawings.drawings
    : EMPTY_DRAWINGS;

  const updateDrawings = useCallback(
    (update: (current: ChartDrawing[]) => ChartDrawing[]) => {
      if (!underlying) return;
      const next = update(
        storedDrawings?.symbol === underlying.symbol ? storedDrawings.drawings : [],
      );
      setStoredDrawings({ symbol: underlying.symbol, drawings: next });
      saveDrawings(underlying.symbol, next);
    },
    [storedDrawings, underlying],
  );

  const scheduleDrawingRefresh = useCallback(() => {
    if (drawingRefreshFrame.current) return;
    drawingRefreshFrame.current = window.requestAnimationFrame(() => {
      drawingRefreshFrame.current = 0;
      setViewRevision((revision) => revision + 1);
    });
  }, []);

  useEffect(() => {
    if (historicalCandles !== undefined) {
      requestVersion.current += 1;
      return;
    }

    if (!chartOpen && !forceOpen) {
      requestVersion.current += 1;
      return;
    }

    if (!underlying) {
      requestVersion.current += 1;
      return;
    }

    const version = ++requestVersion.current;
    const query = new URLSearchParams({
      symbol: underlying.symbol,
      resolution: activeResolution,
    });
    if (historicalFrom && historicalTo) {
      query.set("range_from", historicalFrom);
      query.set("range_to", historicalTo);
    }

    apiRequest(`/api/admin/fyers/history?${query.toString()}`)
      .then(parseCandles)
      .then((items) => {
        if (version === requestVersion.current) {
          setHistory({ key: requestKey, candles: items, error: "" });
        }
      })
      .catch((caught: unknown) => {
        if (version !== requestVersion.current) return;
        setHistory({
          key: requestKey,
          candles: [],
          error: (caught instanceof Error
            ? caught.message
            : "Unable to load spot candles."
          ).replace(/\bfyers\b/gi, "market data service"),
        });
      });

    return () => {
      requestVersion.current += 1;
    };
  }, [
    activeResolution,
    apiRequest,
    chartOpen,
    forceOpen,
    historicalCandles,
    historicalFrom,
    historicalTo,
    requestKey,
    underlying,
  ]);

  useEffect(() => {
    if (!chartApi || !onHistoricalTimeSelect) return;
    const handleClick = (event: MouseEventParams) => {
      if (typeof event.time === "number") onHistoricalTimeSelect(event.time);
    };
    chartApi.subscribeClick(handleClick);
    return () => chartApi.unsubscribeClick(handleClick);
  }, [chartApi, onHistoricalTimeSelect]);

  useEffect(() => {
    liveCandleRef.current = null;
    cumulativeVolumeRef.current = null;
  }, [requestKey]);

  useEffect(() => {
    if (!underlyingSymbol) return;
    const frame = window.requestAnimationFrame(() => {
      const saved = readSavedDrawings(underlyingSymbol);
      setStoredDrawings({ symbol: underlyingSymbol, drawings: saved });
      drawingId.current = Math.max(0, ...saved.map((drawing) => drawing.id)) + 1;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [underlyingSymbol]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      let visible = true;
      try {
        const storedVisibility = window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
        visible = storedVisibility === null ? true : storedVisibility === "true";
      } catch {
        visible = true;
      }
      setChartOpen(forceOpen || visible);
      setChartPreferencesLoaded(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [forceOpen]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(POSITION_STORAGE_KEY);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (isRecord(parsed)) {
        const frame = window.requestAnimationFrame(() => {
          const availableHeight = Math.max(MIN_FLOATING_HEIGHT, window.innerHeight - 32);
          const minimumHeight = Math.min(MIN_FLOATING_HEIGHT, availableHeight);
          const width = typeof parsed.width === "number" && Number.isFinite(parsed.width)
            ? Math.max(340, Math.min(parsed.width, window.innerWidth))
            : Math.min(680, window.innerWidth - 32);
          const storedHeight = typeof parsed.height === "number" && Number.isFinite(parsed.height)
            ? parsed.height
            : Math.min(544, availableHeight);
          const heightBeforeMigration =
            parsed.version === 2 || typeof parsed.height !== "number"
              ? storedHeight
              : storedHeight * 0.8;
          const height = Math.max(
            minimumHeight,
            Math.min(heightBeforeMigration, availableHeight),
          );
          if (
            typeof parsed.left === "number" &&
            Number.isFinite(parsed.left) &&
            typeof parsed.top === "number" &&
            Number.isFinite(parsed.top)
          ) {
            setFloatingPosition({
              left: Math.max(0, Math.min(parsed.left, window.innerWidth - width)),
              top: Math.max(0, Math.min(parsed.top, window.innerHeight - height)),
            });
          }
          setFloatingSize({ width, height });
          try {
            window.localStorage.setItem(
              POSITION_STORAGE_KEY,
              JSON.stringify({ left: parsed.left, top: parsed.top, width, height, version: 2 }),
            );
          } catch {
            return;
          }
        });
        return () => window.cancelAnimationFrame(frame);
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    function applyFloatingPointer() {
      floatingFrame.current = 0;
      const pointer = floatingPointer.current;
      const card = chartCardRef.current;
      if (!pointer || !card) return;
      const start = dragStart.current;
      if (!start) return;
      const width = card.offsetWidth || 720;
      const height = card.offsetHeight || MIN_FLOATING_HEIGHT;
      const left = Math.max(
        0,
        Math.min(window.innerWidth - Math.min(width, 240), start.left + pointer.x - start.pointerX),
      );
      const top = Math.max(
        0,
        Math.min(window.innerHeight - Math.min(height, 80), start.top + pointer.y - start.pointerY),
      );
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      setFloatingPosition({ left, top });
    }
    function moveFloatingChart(event: PointerEvent) {
      if (!dragStart.current) return;
      floatingPointer.current = { x: event.clientX, y: event.clientY };
      if (!floatingFrame.current) {
        floatingFrame.current = window.requestAnimationFrame(applyFloatingPointer);
      }
    }
    function endFloatingDrag() {
      if (!dragStart.current) return;
      if (floatingFrame.current) {
        window.cancelAnimationFrame(floatingFrame.current);
        floatingFrame.current = 0;
        applyFloatingPointer();
      }
      dragStart.current = null;
      floatingPointer.current = null;
      try {
        const card = chartCardRef.current;
        if (card && card.offsetWidth > 0 && card.offsetHeight > 0) {
          const bounds = card.getBoundingClientRect();
          setFloatingPosition({ left: bounds.left, top: bounds.top });
          setFloatingSize({ width: bounds.width, height: bounds.height });
          window.localStorage.setItem(
            POSITION_STORAGE_KEY,
            JSON.stringify({
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              version: 2,
            }),
          );
        }
      } catch {
        return;
      }
    }
    window.addEventListener("pointermove", moveFloatingChart);
    window.addEventListener("pointerup", endFloatingDrag);
    return () => {
      window.removeEventListener("pointermove", moveFloatingChart);
      window.removeEventListener("pointerup", endFloatingDrag);
      window.cancelAnimationFrame(floatingFrame.current);
    };
  }, []);

  const currentHistory = historicalCandles !== undefined
    ? { key: requestKey, candles: historicalCandles, error: "" }
    : history?.key === requestKey
      ? history
      : null;
  const candles = currentHistory?.candles ?? EMPTY_CANDLES;
  const replayIndex = replayTime === null
    ? null
    : candleIndexAtOrBefore(candles, replayTime);
  const loading = underlying !== null && currentHistory === null;
  const error = currentHistory?.error ?? "";
  const externalReplay = historicalSelectedTime !== undefined;
  const externalReplayIndex = historicalSelectedTime === null || historicalSelectedTime === undefined
    ? null
    : candleIndexAtOrBefore(candles, historicalSelectedTime);
  const displayedCandles = externalReplay
    ? externalReplayIndex === null
      ? candles
      : candles.slice(0, externalReplayIndex + 1)
    : replayActive && replayIndex !== null
      ? candles.slice(0, replayIndex + 1)
      : candles;
  const latest = displayedCandles.at(-1);
  const previous = displayedCandles.at(-2);
  const liveSpot = liveTick?.symbol === underlying?.symbol && !replayActive ? liveTick : null;
  const change = liveSpot?.change ?? (latest && previous ? latest.close - previous.close : null);
  const candleSeriesData = useMemo(
    () =>
      displayedCandles.map(({ time, open, high, low, close }) => ({
        time,
        open,
        high,
        low,
        close,
      })),
    [displayedCandles],
  );
  const volumeSeriesData = useMemo(
    () =>
      displayedCandles.map((candle) => ({
        time: candle.time,
        value: candle.volume,
        color:
          candle.close >= candle.open
            ? "rgba(35, 145, 99, 0.48)"
            : "rgba(197, 76, 83, 0.48)",
      })),
    [displayedCandles],
  );

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const colors = getComputedStyle(container);
    const background = colors.getPropertyValue("--chart-background").trim() || "#fff";
    const text = colors.getPropertyValue("--chart-text").trim() || "#53615a";
    const line = colors.getPropertyValue("--chart-line").trim() || "#dce4dd";
    const tickMarkFormatter: TickMarkFormatter = (time, tickMarkType) => {
      if (tickMarkType === TickMarkType.Time || tickMarkType === TickMarkType.TimeWithSeconds) {
        return formatIndiaTime(time, false);
      }
      if (tickMarkType === TickMarkType.Year) {
        return new Intl.DateTimeFormat("en-IN", {
          timeZone: INDIA_TIME_ZONE,
          year: "2-digit",
        }).format(chartTimeDate(time));
      }
      return new Intl.DateTimeFormat("en-IN", {
        timeZone: INDIA_TIME_ZONE,
        day: "2-digit",
        month: "short",
      }).format(chartTimeDate(time));
    };
    const timeFormatter: TimeFormatterFn = (time) => formatIndiaTime(time, true);
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 390,
      layout: {
        background: { type: ColorType.Solid, color: background },
        textColor: text,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: line },
        horzLines: { color: line },
      },
      rightPriceScale: { borderColor: line },
      timeScale: {
        borderColor: line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        tickMarkFormatter,
      },
      localization: {
        locale: "en-IN",
        timeFormatter,
      },
      crosshair: { mode: 0 },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
    });
    const updateCrosshairTime = (event: MouseEventParams) => {
      const label = crosshairTimeRef.current;
      if (!label) return;
      label.textContent = event.time ? formatCrosshairDateTime(event.time) : "";
      label.hidden = !event.time;
    };
    chart.subscribeCrosshairMove(updateCrosshairTime);
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#238f63",
      downColor: "#c54c53",
      borderUpColor: "#238f63",
      borderDownColor: "#c54c53",
      wickUpColor: "#238f63",
      wickDownColor: "#c54c53",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    const initializeFrame = window.requestAnimationFrame(() => {
      setChartApi(chart);
      setCandleSeries(candleSeries);
      setChartDimensions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
      chart.applyOptions({ height: container.clientHeight });
      setChartDimensions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
      const card = chartCardRef.current;
      if (card && card.offsetWidth > 0 && card.offsetHeight > 0) {
        const bounds = card.getBoundingClientRect();
        try {
          window.localStorage.setItem(
            POSITION_STORAGE_KEY,
            JSON.stringify({
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              version: 2,
            }),
          );
        } catch {
          return;
        }
      }
      scheduleDrawingRefresh();
    });
    resizeObserver.observe(container);
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleDrawingRefresh);
    chart.timeScale().subscribeSizeChange(scheduleDrawingRefresh);

    return () => {
      window.cancelAnimationFrame(initializeFrame);
      window.cancelAnimationFrame(drawingRefreshFrame.current);
      drawingRefreshFrame.current = 0;
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(updateCrosshairTime);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleDrawingRefresh);
      chart.timeScale().unsubscribeSizeChange(scheduleDrawingRefresh);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [scheduleDrawingRefresh]);

  const resetChartView = useCallback(() => {
    const chart = chartApi;
    if (!chart || (candleSeriesData.length === 0 && !liveCandleRef.current)) return;
    userAdjustedChart.current = false;
    const timeScale = chart.timeScale();
    const visibleCandles = Math.max(25, Math.floor(timeScale.width() / 8));
    const historyLast = candleSeriesData.at(-1);
    const liveLast = liveCandleRef.current;
    const lastIndex =
      candleSeriesData.length - 1 +
      (liveLast && (!historyLast || liveLast.time > historyLast.time) ? 1 : 0);
    const halfWindow = Math.floor(visibleCandles / 2);
    timeScale.setVisibleLogicalRange({
      from: Math.max(0, lastIndex - halfWindow),
      to: lastIndex + halfWindow,
    });
    chart.priceScale("right").applyOptions({ autoScale: true });
  }, [candleSeriesData, chartApi]);

  useEffect(() => {
    if (!chartApi || !candleSeries || !volumeSeriesRef.current) return;
    candleSeries.setData(candleSeriesData);
    volumeSeriesRef.current.setData(volumeSeriesData);
    if (candleSeriesData.length) {
      if (replayActive && replayIndex !== null) {
        const visibleCandles = Math.max(25, Math.floor(chartApi.timeScale().width() / 8));
        const halfWindow = Math.floor(visibleCandles / 2);
        chartApi.timeScale().setVisibleLogicalRange({
          from: Math.max(0, replayIndex - halfWindow),
          to: replayIndex + halfWindow,
        });
        chartApi.priceScale("right").applyOptions({ autoScale: true });
      }
    }
  }, [
    candleSeries,
    candleSeriesData,
    chartApi,
    replayActive,
    replayIndex,
    volumeSeriesData,
  ]);

  useEffect(() => {
    if (candleSeriesData.length === 0) {
      userAdjustedChart.current = false;
    } else if (!userAdjustedChart.current) {
      resetChartView();
    }
  }, [candleSeriesData, resetChartView]);

  useEffect(() => {
    if (!liveSpot || replayActive || !chartApi || !candleSeries || !volumeSeriesRef.current) return;
    const timestamp = liveSpot.time ?? Math.floor(Date.now() / 1000);
    const time = liveCandleStart(timestamp, resolution);
    const previousBar = liveCandleRef.current;
    const lastHistoryBar = candles.at(-1);
    if (
      (lastHistoryBar && time < lastHistoryBar.time) ||
      (previousBar && time < previousBar.time)
    ) return;
    const baseBar = previousBar?.time === time
      ? previousBar
      : lastHistoryBar?.time === time
        ? lastHistoryBar
        : null;
    const previousCumulativeVolume = cumulativeVolumeRef.current;
    const volumeDelta = liveSpot.volume !== null && previousCumulativeVolume !== null
      ? Math.max(0, liveSpot.volume - previousCumulativeVolume)
      : 0;
    if (liveSpot.volume !== null) cumulativeVolumeRef.current = liveSpot.volume;
    const bar: Candle = baseBar
      ? {
          ...baseBar,
          high: Math.max(baseBar.high, liveSpot.ltp),
          low: Math.min(baseBar.low, liveSpot.ltp),
          close: liveSpot.ltp,
          volume: baseBar.volume + volumeDelta,
        }
      : {
          time,
          open: liveSpot.ltp,
          high: liveSpot.ltp,
          low: liveSpot.ltp,
          close: liveSpot.ltp,
          volume: volumeDelta,
        };
    try {
      candleSeries.update({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
      volumeSeriesRef.current.update({
        time: bar.time,
        value: bar.volume,
        color: bar.close >= bar.open
          ? "rgba(35, 145, 99, 0.48)"
          : "rgba(197, 76, 83, 0.48)",
      });
      liveCandleRef.current = bar;
      if (!userAdjustedChart.current) resetChartView();
      scheduleDrawingRefresh();
    } catch (caught) {
      console.error("Unable to update the live chart candle.", caught);
    }
  }, [
    candles,
    candleSeries,
    chartApi,
    liveSpot,
    replayActive,
    resetChartView,
    resolution,
    scheduleDrawingRefresh,
  ]);

  useEffect(() => {
    if (!replayPlaying || replayIndex === null) return;
    const timer = window.setInterval(() => {
      if (replayIndex >= candles.length - 1) {
        setReplayPlaying(false);
        return;
      }
      setReplayTime(candles[replayIndex + 1].time);
    }, 700);
    return () => window.clearInterval(timer);
  }, [candles, replayIndex, replayPlaying]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActiveTool("cursor");
      setPendingDrawing(null);
      setContextMenu(null);
      if (replayActive) {
        setReplayActive(false);
        setReplayTime(null);
        setReplayPlaying(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [replayActive]);

  function chartPoint(clientX: number, clientY: number): DrawingPoint | null {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const container = chartContainerRef.current;
    if (!chart || !series || !container) return null;

    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || x > chart.timeScale().width() || y < 0 || y > container.clientHeight - chart.timeScale().height()) {
      return null;
    }
    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (typeof time !== "number" || typeof price !== "number") return null;
    return { time, price };
  }

  function handleDrawingClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (replayActive) {
      const point = chartPoint(event.clientX, event.clientY);
      if (!point) return;
      const index = candleIndexAtOrBefore(candles, point.time);
      if (index === null) return;
      setReplayTime(candles[index].time);
      setReplayPlaying(false);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (activeTool === "cursor") return;
    const point = chartPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();

    if (activeTool === "horizontal" || activeTool === "ray" || activeTool === "vertical") {
      updateDrawings((current) => [
        ...current,
        { id: ++drawingId.current, tool: activeTool, start: point },
      ]);
      return;
    }

    if (!pendingDrawing || pendingDrawing.tool !== activeTool) {
      setPendingDrawing({
        id: ++drawingId.current,
        tool: activeTool,
        start: point,
      });
      return;
    }

    updateDrawings((current) => [...current, { ...pendingDrawing, end: point }]);
    setPendingDrawing(null);
  }

  function startDrawingDrag(
    event: ReactPointerEvent<SVGElement>,
    drawing: ChartDrawing,
  ) {
    if (activeTool !== "cursor" || replayActive) return;
    const point = chartPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawingDrag({ drawing, pointer: point });
    setDrawingDragPreview(point);
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const point = chartPoint(event.clientX, event.clientY);
    if (!point) {
      setPointerPoint(null);
      return;
    }
    if (drawingDrag) setDrawingDragPreview(point);
    setPointerPoint(point);
  }

  function movedDrawing(
    drawing: ChartDrawing,
    origin: DrawingPoint,
    destination: DrawingPoint,
  ): ChartDrawing {
    const deltaTime = destination.time - origin.time;
    const deltaPrice = destination.price - origin.price;
    const shiftTime = drawing.tool !== "horizontal" && drawing.tool !== "ray";
    const shiftPrice = drawing.tool !== "vertical";
    return {
      ...drawing,
      start: {
        time: drawing.start.time + (shiftTime ? deltaTime : 0),
        price: drawing.start.price + (shiftPrice ? deltaPrice : 0),
      },
      ...(drawing.end
        ? {
            end: {
              time: drawing.end.time + (shiftTime ? deltaTime : 0),
              price: drawing.end.price + (shiftPrice ? deltaPrice : 0),
            },
          }
        : {}),
    };
  }

  function finishDrawingDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = drawingDrag;
    if (!drag) return;
    setDrawingDrag(null);
    setDrawingDragPreview(null);
    const point = chartPoint(event.clientX, event.clientY);
    if (!point) return;
    updateDrawings((current) =>
      current.map((drawing) =>
        drawing.id !== drag.drawing.id
          ? drawing
          : movedDrawing(drawing, drag.pointer, point),
      ),
    );
    scheduleDrawingRefresh();
  }

  function handleChartContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = chartShellRef.current?.getBoundingClientRect();
    if (rect) {
      setContextMenu({
        x: Math.max(4, Math.min(event.clientX - rect.left, rect.width - 190)),
        y: Math.max(4, Math.min(event.clientY - rect.top, rect.height - 90)),
      });
    }
  }

  function startFloatingDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    const bounds = chartCardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: bounds.left,
      top: bounds.top,
    };
    const card = chartCardRef.current;
    if (card) {
      card.style.left = `${bounds.left}px`;
      card.style.top = `${bounds.top}px`;
      card.style.right = "auto";
      card.style.bottom = "auto";
    }
    setFloatingPosition({ left: bounds.left, top: bounds.top });
  }

  function startFloatingResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: FloatingResizeAxis,
  ) {
    const bounds = chartCardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    const card = chartCardRef.current;
    if (card) {
      card.style.left = `${bounds.left}px`;
      card.style.top = `${bounds.top}px`;
      card.style.right = "auto";
      card.style.bottom = "auto";
    }
    setFloatingPosition({ left: bounds.left, top: bounds.top });
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const onMove = (pointer: PointerEvent) => {
      const card = chartCardRef.current;
      if (!card || pointer.pointerId !== pointerId) return;
      const availableWidth = Math.max(240, window.innerWidth - bounds.left);
      const minimumWidth = Math.min(340, availableWidth);
      const width = axis === "both"
        ? Math.max(minimumWidth, Math.min(availableWidth, bounds.width + pointer.clientX - start.x))
        : bounds.width;
      const availableHeight = Math.max(MIN_FLOATING_HEIGHT, window.innerHeight - bounds.top);
      const minimumHeight = Math.min(MIN_FLOATING_HEIGHT, availableHeight);
      const height = Math.max(minimumHeight, Math.min(availableHeight, bounds.height + pointer.clientY - start.y));
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
      setFloatingSize({ width, height });
    };
    const onEnd = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      const card = chartCardRef.current;
      if (!card || card.offsetWidth <= 0 || card.offsetHeight <= 0) return;
      const currentBounds = card.getBoundingClientRect();
      setFloatingPosition({ left: currentBounds.left, top: currentBounds.top });
      setFloatingSize({ width: currentBounds.width, height: currentBounds.height });
      try {
        window.localStorage.setItem(
          POSITION_STORAGE_KEY,
          JSON.stringify({
            left: currentBounds.left,
            top: currentBounds.top,
            width: currentBounds.width,
            height: currentBounds.height,
            version: 2,
          }),
        );
      } catch {
        return;
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
  }

  function updateChartVisibility(visible: boolean) {
    setChartOpen(visible);
    try {
      window.localStorage.setItem(VISIBILITY_STORAGE_KEY, String(visible));
    } catch {
      return;
    }
  }

  const plotWidth = chartApi?.timeScale().width() ?? 0;
  const plotHeight =
    chartDimensions.height - (chartApi?.timeScale().height() ?? 0);
  const drawingElements = drawings.map((storedDrawing) => {
    const drag = drawingDrag;
    const drawing =
      drag?.drawing.id === storedDrawing.id && drawingDragPreview
        ? movedDrawing(drag.drawing, drag.pointer, drawingDragPreview)
        : storedDrawing;
    const points = drawingCoordinates(chartApi, candleSeries, drawing, candles);
    if (!points) return null;
    const common = {
      stroke: "#e5a323",
      strokeWidth: 1.5,
      vectorEffect: "non-scaling-stroke" as const,
    };
    if (drawing.tool === "horizontal") {
      return (
        <g key={drawing.id}>
          <line {...common} x1={0} x2={plotWidth} y1={points.startY} y2={points.startY}>
            <title>Horizontal line · {formatPrice(drawing.start.price)}</title>
          </line>
          <line
            x1={0} x2={plotWidth} y1={points.startY} y2={points.startY}
            stroke="transparent" strokeWidth={12} pointerEvents="stroke"
            style={{ cursor: "move" }} onPointerDown={(event) => startDrawingDrag(event, drawing)}
          />
        </g>
      );
    }
    if (drawing.tool === "ray") {
      return (
        <g key={drawing.id}>
          <line {...common} x1={points.startX} x2={plotWidth} y1={points.startY} y2={points.startY}>
            <title>Horizontal ray · {formatPrice(drawing.start.price)}</title>
          </line>
          <line
            x1={points.startX} x2={plotWidth} y1={points.startY} y2={points.startY}
            stroke="transparent" strokeWidth={12} pointerEvents="stroke"
            style={{ cursor: "move" }} onPointerDown={(event) => startDrawingDrag(event, drawing)}
          />
        </g>
      );
    }
    if (drawing.tool === "vertical") {
      return (
        <g key={drawing.id}>
          <line {...common} x1={points.startX} x2={points.startX} y1={0} y2={plotHeight}>
            <title>Vertical line</title>
          </line>
          <line
            x1={points.startX} x2={points.startX} y1={0} y2={plotHeight}
            stroke="transparent" strokeWidth={12} pointerEvents="stroke"
            style={{ cursor: "move" }} onPointerDown={(event) => startDrawingDrag(event, drawing)}
          />
        </g>
      );
    }
    const endX = points.endX ?? points.startX;
    const endY = points.endY ?? points.startY;
    if (drawing.tool === "trend") {
      return (
        <g key={drawing.id}>
          <line {...common} stroke="#2e7be6" x1={points.startX} x2={endX} y1={points.startY} y2={endY}>
            <title>Trend line</title>
          </line>
          <line
            x1={points.startX} x2={endX} y1={points.startY} y2={endY}
            stroke="transparent" strokeWidth={12} pointerEvents="stroke"
            style={{ cursor: "move" }} onPointerDown={(event) => startDrawingDrag(event, drawing)}
          />
        </g>
      );
    }
    if (drawing.tool === "fibonacci") {
      return (
        <g key={drawing.id}>
          {FIBONACCI_LEVELS.map((level) => {
            const price =
              drawing.start.price +
              (drawing.end!.price - drawing.start.price) * level;
            const y = candleSeries?.priceToCoordinate(price);
            return y === null || y === undefined ? null : (
              <g key={level}>
                <line
                  stroke="#2e7be6"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                  x1={Math.min(points.startX, endX)}
                  x2={Math.max(points.startX, endX)}
                  y1={y}
                  y2={y}
                />
                <line
                  x1={Math.min(points.startX, endX)}
                  x2={Math.max(points.startX, endX)}
                  y1={y}
                  y2={y}
                  stroke="transparent"
                  strokeWidth={12}
                  pointerEvents="stroke"
                  style={{ cursor: "move" }}
                  onPointerDown={(event) => startDrawingDrag(event, drawing)}
                />
                <text
                  x={Math.max(points.startX, endX) - 4}
                  y={y - 3}
                  fill="#2e7be6"
                  fontSize={10}
                  textAnchor="end"
                >
                  {`${(level * 100).toFixed(1)}% · ${formatPrice(price)}`}
                </text>
              </g>
            );
          })}
        </g>
      );
    }
    return (
    <g key={drawing.id}>
      <rect
        {...common}
        stroke="#2e7be6"
        fill="rgba(46, 123, 230, .08)"
        x={Math.min(points.startX, endX)}
        y={Math.min(points.startY, endY)}
        width={Math.abs(endX - points.startX)}
        height={Math.abs(endY - points.startY)}
      >
        <title>Price range</title>
      </rect>
      <rect
        stroke="transparent"
        fill="transparent"
        pointerEvents="all"
        style={{ cursor: "move" }}
        x={Math.min(points.startX, endX)}
        y={Math.min(points.startY, endY)}
        width={Math.abs(endX - points.startX)}
        height={Math.abs(endY - points.startY)}
        onPointerDown={(event) => startDrawingDrag(event, drawing)}
      />
    </g>
    );
  });
  const previewCoordinates = pendingDrawing && pointerPoint
    ? drawingCoordinates(chartApi, candleSeries, { ...pendingDrawing, end: pointerPoint }, candles)
    : null;

  return (
    <>
    {chartPreferencesLoaded && !chartOpen && (
      <button
        type="button"
        className={styles.chartLauncher}
        onClick={() => updateChartVisibility(true)}
      >
        Open spot chart · {underlying?.label ?? "Chart"}
      </button>
    )}
    <section
      className={`${styles.chartCard} ${opaque ? styles.chartCardOpaque : ""} ${!chartPreferencesLoaded || !chartOpen ? styles.chartMinimized : ""}`}
      aria-label="Spot price chart"
      ref={chartCardRef}
      style={{
        ...(floatingPosition ? { left: floatingPosition.left, top: floatingPosition.top, right: "auto", bottom: "auto" } : {}),
        ...(floatingSize ? { width: floatingSize.width, height: floatingSize.height } : {}),
      }}
    >
      <header className={styles.chartHeader} onPointerDown={startFloatingDrag}>
        <div>
          <p className={styles.chartEyebrow}>Spot chart</p>
          <h3>{underlying?.label ?? "Underlying"} · Candles</h3>
          <span>{underlying?.symbol ?? "Select an underlying"}</span>
        </div>
        <div className={styles.headerActions}>
          {latest && (
            <div className={styles.latestQuote}>
              <strong>{formatPrice(liveSpot?.ltp ?? latest.close)}</strong>
              {change !== null && (
                <span className={change >= 0 ? styles.positive : styles.negative}>
                  {change > 0 ? "+" : ""}
                  {formatPrice(change)}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            className={styles.windowButton}
            aria-label={chartOpen ? "Minimize chart" : "Open chart"}
            title={chartOpen ? "Minimize chart" : "Open chart"}
            onClick={() => updateChartVisibility(!chartOpen)}
          >
            {chartOpen ? "−" : "↗"}
          </button>
        </div>
      </header>
      <div className={styles.chartToolbar}>
        <div className={styles.intervalGroup} role="toolbar" aria-label="Candle interval">
          {RESOLUTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={activeResolution === item.value}
              className={activeResolution === item.value ? styles.intervalActive : undefined}
              disabled={!underlying || historicalResolution !== undefined}
              onClick={() => {
                setReplayPlaying(false);
                setResolution(item.value);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {!externalReplay && <div className={styles.replayGroup} role="toolbar" aria-label="Candle replay">
          {!replayActive ? (
            <button
              type="button"
              disabled={candles.length < 2}
              onClick={() => {
                setActiveTool("cursor");
                setPendingDrawing(null);
                setReplayTime(null);
                setReplayPlaying(false);
                setReplayActive(true);
              }}
            >
              Replay
            </button>
          ) : (
            <>
              <span className={styles.replayInstruction}>
                {replayIndex === null ? "Select a candle to start" : `Replay · ${replayIndex + 1}/${candles.length}`}
              </span>
              <button
                type="button"
                aria-label="Previous replay candle"
                title="Previous candle"
                disabled={replayIndex === null || replayIndex <= 0}
                onClick={() => {
                  setReplayPlaying(false);
                  setReplayTime((current) => {
                    const index = current === null ? null : candleIndexAtOrBefore(candles, current);
                    return index === null || index <= 0 ? current : candles[index - 1].time;
                  });
                }}
              >
                ◀
              </button>
              <button
                type="button"
                aria-label={replayPlaying ? "Pause replay" : "Play replay"}
                title={replayPlaying ? "Pause replay" : "Play replay"}
                disabled={replayIndex === null || replayIndex >= candles.length - 1}
                onClick={() => setReplayPlaying((playing) => !playing)}
              >
                {replayPlaying ? "Ⅱ" : "▶"}
              </button>
              <button
                type="button"
                aria-label="Next replay candle"
                title="Next candle"
                disabled={replayIndex === null || replayIndex >= candles.length - 1}
                onClick={() => {
                  setReplayPlaying(false);
                  setReplayTime((current) => {
                    const index = current === null ? null : candleIndexAtOrBefore(candles, current);
                    return index === null ? current : candles[Math.min(candles.length - 1, index + 1)].time;
                  });
                }}
              >
                ▶|
              </button>
              <button
                type="button"
                onClick={() => {
                  setReplayPlaying(false);
                  setReplayTime(null);
                  setReplayActive(false);
                }}
              >
                Exit
              </button>
            </>
          )}
        </div>}
        {latest && (
          <span className={styles.volumeSummary}>
            Volume <strong>{formatVolume(latest.volume)}</strong>
          </span>
        )}
      </div>
      {externalReplay && externalReplayControls && (
        <div className={styles.externalReplayControls}>
          {externalReplayControls}
        </div>
      )}
      <div
        className={styles.chartShell}
        aria-busy={loading}
        ref={chartShellRef}
        onContextMenu={handleChartContextMenu}
        onPointerDown={() => {
          userAdjustedChart.current = true;
          if (contextMenu) setContextMenu(null);
        }}
        onPointerUp={scheduleDrawingRefresh}
        onWheelCapture={() => {
          userAdjustedChart.current = true;
          scheduleDrawingRefresh();
        }}
      >
        <div className={styles.chartContainer} ref={chartContainerRef} />
        <div className={styles.crosshairTime} ref={crosshairTimeRef} hidden aria-hidden="true" />
        <svg
          className={
            activeTool === "cursor" && !replayActive
              ? styles.drawingLayer
              : styles.drawingLayerActive
          }
          viewBox={`0 0 ${chartDimensions.width || 1} ${chartDimensions.height || 1}`}
          preserveAspectRatio="none"
          data-view-revision={viewRevision}
          onClick={handleDrawingClick}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrawingDrag}
          onPointerLeave={() => setPointerPoint(null)}
          onContextMenu={(event) => event.preventDefault()}
          aria-label="Chart drawings"
        >
          {drawingElements}
          {previewCoordinates && pendingDrawing && (
            pendingDrawing.tool === "trend" ? (
              <line
                className={styles.drawingPreview}
                x1={previewCoordinates.startX}
                y1={previewCoordinates.startY}
                x2={previewCoordinates.endX ?? previewCoordinates.startX}
                y2={previewCoordinates.endY ?? previewCoordinates.startY}
              />
            ) : pendingDrawing.tool === "fibonacci" ? (
              <g className={styles.drawingPreview}>
                {FIBONACCI_LEVELS.map((level) => {
                  const y =
                    previewCoordinates.startY +
                    ((previewCoordinates.endY ?? previewCoordinates.startY) -
                      previewCoordinates.startY) * level;
                  return (
                    <line
                      key={level}
                      x1={Math.min(
                        previewCoordinates.startX,
                        previewCoordinates.endX ?? previewCoordinates.startX,
                      )}
                      x2={Math.max(
                        previewCoordinates.startX,
                        previewCoordinates.endX ?? previewCoordinates.startX,
                      )}
                      y1={y}
                      y2={y}
                    />
                  );
                })}
              </g>
            ) : (
              <rect
                className={styles.drawingPreview}
                x={Math.min(previewCoordinates.startX, previewCoordinates.endX ?? previewCoordinates.startX)}
                y={Math.min(previewCoordinates.startY, previewCoordinates.endY ?? previewCoordinates.startY)}
                width={Math.abs((previewCoordinates.endX ?? previewCoordinates.startX) - previewCoordinates.startX)}
                height={Math.abs((previewCoordinates.endY ?? previewCoordinates.startY) - previewCoordinates.startY)}
              />
            )
          )}
        </svg>
        {replayActive && (
          <div className={styles.drawingHint}>
            {replayIndex === null ? "Click a candle to start replay" : "Use replay controls to step through candles"}
          </div>
        )}
        {!replayActive && activeTool !== "cursor" && (
          <div className={styles.drawingHint}>
            {pendingDrawing ? "Click to finish drawing" : "Click chart to place drawing"}
          </div>
        )}
        {contextMenu && (
          <div
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                resetChartView();
                setContextMenu(null);
              }}
            >
              Reset chart view
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={drawings.length === 0}
              onClick={() => {
                updateDrawings(() => []);
                setContextMenu(null);
              }}
            >
              Remove all drawings
            </button>
          </div>
        )}
        {loading && <div className={styles.chartOverlay}>Loading candles…</div>}
        {!loading && error && <div className={styles.chartOverlay} role="alert">{error}</div>}
        {!loading && !error && candles.length === 0 && (
          <div className={styles.chartOverlay}>No spot candles available for this interval.</div>
        )}
      </div>
      <button
        type="button"
        className={styles.resizeHandle}
        aria-label="Resize chart window"
        title="Drag to resize chart"
        onPointerDown={(event) => startFloatingResize(event, "both")}
      />
      <button
        type="button"
        className={styles.heightResizeHandle}
        aria-label="Adjust chart height"
        title="Drag to adjust chart height"
        onPointerDown={(event) => startFloatingResize(event, "height")}
      />
    </section>
    </>
  );
}
