'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  createChart,
  createSeriesMarkers,
  ColorType,
  CandlestickSeries,
  LineSeries,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  Time,
} from 'lightweight-charts';
import { Maximize2, Minimize2 } from 'lucide-react';

const TV = {
  bg: '#131722', grid: '#1e222d', axisText: '#787b86', up: '#26a69a', down: '#ef5350',
  sma20: '#2962ff', sma50: '#ff6d00', entry: '#C6A15B',
};

export type Candle = { time: number; o: number; h: number; l: number; c: number; sma20: number | null; sma50: number | null };

// One entry per executed trade — the chart needs a unix-seconds timestamp per
// trade (separate from the human-readable clock string used in the ledger UI).
export type TradeMarker = { ts: number; side: 'BUY' | 'SELL'; price: number };

function buildTradeMarkers(trades: TradeMarker[]): SeriesMarker<Time>[] {
  // lightweight-charts requires markers in ascending time order; the ledger
  // stores newest-first, so this also handles the reversal.
  return [...trades]
    .filter((t) => typeof t.ts === 'number' && !isNaN(t.ts))
    .sort((a, b) => a.ts - b.ts)
    .map((t) => ({
      time: t.ts as unknown as Time,
      position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
      color: t.side === 'BUY' ? TV.up : TV.down,
      shape: t.side === 'BUY' ? 'arrowUp' : 'arrowDown',
      text: `${t.side} $${t.price.toFixed(2)}`,
    }));
}

function fmtUSD(n: number | null | undefined, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export const TIMEFRAMES = [
  { key: '1D', label: '1D', groupSize: 1 },
  { key: '20s', label: '20s', groupSize: 5 },
  { key: '1m', label: '1m', groupSize: 15 },
  { key: '5m', label: '5m', groupSize: 75 },
  { key: '15m', label: '15m', groupSize: 225 },
] as const;
export type TimeframeKey = (typeof TIMEFRAMES)[number]['key'];

// --- Position zone overlay -------------------------------------------------
// Renders the TradingView "long position" style box: a green zone from entry
// to target, a red zone from entry to stop, an entry line with handles, and
// labels for target/stop/open-PnL/risk-reward. Pure DOM overlay on top of the
// chart canvas — lightweight-charts has no built-in equivalent primitive, so
// coordinates are read back out of the chart/series APIs on every layout
// change (resize, pan/zoom, new candle, or prop change) and redrawn as plain
// positioned divs.
function PositionZoneOverlay({
  chart,
  series,
  container,
  entryPrice,
  slPrice,
  tpPrice,
  qty,
  currentPrice,
}: {
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  container: HTMLDivElement | null;
  entryPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  qty: number | null;
  currentPrice: number | null;
  layoutTick: number;
}) {
  if (!chart || !series || !container || entryPrice == null || slPrice == null || tpPrice == null || !qty) return null;

  const yEntry = series.priceToCoordinate(entryPrice);
  const yTp = series.priceToCoordinate(tpPrice);
  const ySl = series.priceToCoordinate(slPrice);
  if (yEntry == null || yTp == null || ySl == null) return null;

  const width = container.clientWidth;
  let rightScaleWidth = 0;
  try {
    rightScaleWidth = chart.priceScale('right').width();
  } catch {
    rightScaleWidth = 56;
  }
  const xLeft = 6;
  const xRight = Math.max(xLeft + 60, width - rightScaleWidth - 6);
  const boxWidth = xRight - xLeft;

  const tpPct = ((tpPrice - entryPrice) / entryPrice) * 100;
  const slPct = ((slPrice - entryPrice) / entryPrice) * 100;
  const tpAmount = qty * (tpPrice - entryPrice);
  const slAmount = qty * (entryPrice - slPrice);
  const rr = slAmount !== 0 ? Math.abs(tpAmount / slAmount) : null;
  const openPnl = currentPrice != null ? qty * (currentPrice - entryPrice) : null;

  const labelBase: React.CSSProperties = {
    position: 'absolute',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: '#fff',
    padding: '3px 7px',
    borderRadius: 3,
    whiteSpace: 'nowrap',
    lineHeight: 1.5,
  };

  const handleDot = (x: number, y: number, color: string, key: string) => (
    <div
      key={key}
      style={{
        position: 'absolute',
        left: x - 4,
        top: y - 4,
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: TV.bg,
        border: `2px solid ${color}`,
      }}
    />
  );

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {/* target zone (entry -> tp) */}
      <div
        style={{
          position: 'absolute',
          left: xLeft,
          width: boxWidth,
          top: Math.min(yEntry, yTp),
          height: Math.abs(yEntry - yTp),
          background: 'rgba(38,166,154,0.15)',
          borderTop: yTp < yEntry ? `1px solid ${TV.up}` : undefined,
          borderBottom: yTp > yEntry ? `1px solid ${TV.up}` : undefined,
        }}
      />
      {/* stop zone (entry -> sl) */}
      <div
        style={{
          position: 'absolute',
          left: xLeft,
          width: boxWidth,
          top: Math.min(yEntry, ySl),
          height: Math.abs(yEntry - ySl),
          background: 'rgba(239,83,80,0.15)',
          borderTop: ySl < yEntry ? `1px solid ${TV.down}` : undefined,
          borderBottom: ySl > yEntry ? `1px solid ${TV.down}` : undefined,
        }}
      />
      {/* entry line */}
      <div style={{ position: 'absolute', left: xLeft, width: boxWidth, top: yEntry - 1, height: 2, background: TV.entry }} />

      {handleDot(xLeft, yTp, TV.up, 'tp-l')}
      {handleDot(xRight, yTp, TV.up, 'tp-r')}
      {handleDot(xLeft, yEntry, TV.entry, 'en-l')}
      {handleDot(xRight, yEntry, TV.entry, 'en-r')}
      {handleDot(xLeft, ySl, TV.down, 'sl-l')}
      {handleDot(xRight, ySl, TV.down, 'sl-r')}

      {/* target label, pinned to the top-right of the target line */}
      <div style={{ ...labelBase, background: TV.up, right: width - xRight, top: yTp - (yTp <= yEntry ? 22 : 4) }}>
        Target: ${fmtUSD(tpPrice)} ({tpPct >= 0 ? '+' : ''}{tpPct.toFixed(2)}%) {qty.toFixed(4)} oz, Amount ${fmtUSD(Math.abs(tpAmount), 0)}
      </div>

      {/* stop label, pinned to the bottom-right of the stop line */}
      <div style={{ ...labelBase, background: TV.down, right: width - xRight, top: ySl + (ySl >= yEntry ? 4 : -22) }}>
        Stop: ${fmtUSD(slPrice)} ({slPct >= 0 ? '+' : ''}{slPct.toFixed(2)}%) {qty.toFixed(4)} oz, Amount ${fmtUSD(Math.abs(slAmount), 0)}
      </div>

      {/* open PnL / risk-reward label, centered near the entry line */}
      {openPnl != null && (
        <div
          style={{
            ...labelBase,
            background: openPnl >= 0 ? TV.up : TV.down,
            left: xLeft + boxWidth * 0.32,
            top: yEntry + 10,
            textAlign: 'center',
          }}
        >
          Open PnL: {openPnl >= 0 ? '+' : '-'}${fmtUSD(Math.abs(openPnl))}, Qty: {qty.toFixed(4)} oz
          <br />
          Risk/reward ratio: {rr != null ? rr.toFixed(2) : '--'}
        </div>
      )}
    </div>
  );
}

export default function PriceChart({
  candles,
  height = 340,
  timeframe,
  onTimeframeChange,
  entryPrice,
  slPrice,
  tpPrice,
  qty,
  currentPrice,
  trades = [],
}: {
  candles: Candle[];
  height?: number;
  timeframe: TimeframeKey;
  onTimeframeChange: (tf: TimeframeKey) => void;
  entryPrice?: number | null;
  slPrice?: number | null;
  tpPrice?: number | null;
  qty?: number | null;
  currentPrice?: number | null;
  trades?: TradeMarker[];
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const sma20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const sma50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Bumped whenever chart layout could have shifted the pixel coordinates the
  // overlay depends on (resize, pan/zoom, new data). The overlay reads live
  // values straight off the chart/series refs at render time, so it just
  // needs *a* re-render to pick up the latest numbers — the value itself is
  // never read.
  const [layoutTick, setLayoutTick] = useState(0);
  const bump = useCallback(() => setLayoutTick((v) => v + 1), []);

  // Mirrors of the latest props, read by the remount effect (which must not
  // depend on candles/entryPrice/etc. directly — it should only re-run when
  // `fullscreen` changes, not on every price tick).
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const tradesRef = useRef(trades);
  tradesRef.current = trades;

  // Recreated whenever `fullscreen` flips (see dependency array below and the
  // `key` on the container div). Resizing an EXISTING lightweight-charts canvas
  // across a position:fixed <-> static transition proved unreliable — the
  // canvas would get stuck at its old pixel size. Destroying and recreating
  // the chart sidesteps that: a brand-new canvas is always born at the
  // container's *current* size, so there's nothing stale to get stuck at.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: TV.bg },
        textColor: TV.axisText,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: TV.grid }, horzLines: { color: TV.grid } },
      rightPriceScale: { borderColor: TV.grid },
      timeScale: { borderColor: TV.grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || height,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: TV.up, downColor: TV.down, borderVisible: false, wickUpColor: TV.up, wickDownColor: TV.down,
    });
    const sma20Series = chart.addSeries(LineSeries, { color: TV.sma20, lineWidth: 1, priceLineVisible: false });
    const sma50Series = chart.addSeries(LineSeries, { color: TV.sma50, lineWidth: 1, priceLineVisible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    sma20SeriesRef.current = sma20Series;
    sma50SeriesRef.current = sma50Series;
    markersPluginRef.current = createSeriesMarkers(candleSeries, buildTradeMarkers(tradesRef.current));

    // Seed immediately with whatever data we currently have — the other
    // effects below only re-run when candles themselves change, not when the
    // chart is torn down and rebuilt, so without this a fresh chart would
    // render blank until the next candle tick.
    if (candlesRef.current.length) {
      candleSeries.setData(candlesRef.current.map((c) => ({ time: c.time as any, open: c.o, high: c.h, low: c.l, close: c.c })));
      sma20Series.setData(candlesRef.current.filter((c) => c.sma20 != null).map((c) => ({ time: c.time as any, value: c.sma20 as number })));
      sma50Series.setData(candlesRef.current.filter((c) => c.sma50 != null).map((c) => ({ time: c.time as any, value: c.sma50 as number })));
      chart.timeScale().scrollToRealTime();
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(bump);

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight, true);
      bump();
    });
    ro.observe(containerRef.current);

    bump(); // first paint once refs are populated

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(bump);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [fullscreen, bump, height]);

  const toggleFullscreen = () => setFullscreen((f) => !f);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return;

    // Snapshot whether the user was already looking at the live edge BEFORE we
    // touch the data. scrollPosition() is the distance (in bars) from the right
    // edge — 0 means "at the live edge". If they've panned or zoomed away from
    // it, respect that and don't yank them back on every new candle.
    const scrollPos = chartRef.current?.timeScale().scrollPosition() ?? 0;
    const wasAtLiveEdge = Math.abs(scrollPos) < 2;

    candleSeriesRef.current.setData(candles.map((c) => ({ time: c.time as any, open: c.o, high: c.h, low: c.l, close: c.c })));
    sma20SeriesRef.current?.setData(candles.filter((c) => c.sma20 != null).map((c) => ({ time: c.time as any, value: c.sma20 as number })));
    sma50SeriesRef.current?.setData(candles.filter((c) => c.sma50 != null).map((c) => ({ time: c.time as any, value: c.sma50 as number })));

    if (wasAtLiveEdge) {
      chartRef.current?.timeScale().scrollToRealTime();
    }
    bump();
  }, [candles, bump]);

  // Persistent buy/sell markers — one per executed trade, kept on the chart
  // permanently. This never touches pan/zoom.
  useEffect(() => {
    markersPluginRef.current?.setMarkers(buildTradeMarkers(trades));
  }, [trades]);

  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%',
        height: fullscreen ? '100vh' : undefined,
        position: fullscreen ? 'fixed' : 'static',
        top: fullscreen ? 0 : undefined,
        left: fullscreen ? 0 : undefined,
        zIndex: fullscreen ? 9999 : undefined,
        background: fullscreen ? TV.bg : undefined,
        padding: fullscreen ? 16 : 0,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              onClick={() => onTimeframeChange(tf.key)}
              style={{
                background: timeframe === tf.key ? '#2A2B2D' : 'transparent',
                color: timeframe === tf.key ? '#E8C878' : TV.axisText,
                border: '1px solid #2A2B2D',
                borderRadius: 4,
                padding: '3px 9px',
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                cursor: 'pointer',
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <button
          onClick={toggleFullscreen}
          style={{ background: 'transparent', border: '1px solid #2A2B2D', borderRadius: 4, padding: '4px 6px', color: TV.axisText, cursor: 'pointer', display: 'flex' }}
          title={fullscreen ? 'Exit full view (Esc)' : 'Full view'}
        >
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <div
        style={{
          position: 'relative',
          flex: 1,
          width: '100%',
          height: fullscreen ? undefined : height,
          minHeight: fullscreen ? 0 : height,
        }}
      >
        <div ref={containerRef} key={fullscreen ? 'fs' : 'normal'} style={{ position: 'absolute', inset: 0 }} />
        <PositionZoneOverlay
          chart={chartRef.current}
          series={candleSeriesRef.current}
          container={containerRef.current}
          entryPrice={entryPrice ?? null}
          slPrice={slPrice ?? null}
          tpPrice={tpPrice ?? null}
          qty={qty ?? null}
          currentPrice={currentPrice ?? null}
          layoutTick={layoutTick}
        />
      </div>
    </div>
  );
}