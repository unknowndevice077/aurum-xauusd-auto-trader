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
  IPriceLine,
  SeriesMarker,
  Time,
} from 'lightweight-charts';
import { Maximize2, Minimize2 } from 'lucide-react';

const TV = {
  bg: '#131722', grid: '#1e222d', axisText: '#787b86', up: '#26a69a', down: '#ef5350',
  sma20: '#2962ff', sma50: '#ff6d00', entry: '#C6A15B', sl: '#f23645', tp: '#089981', be: '#9aa0a6',
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

export const TIMEFRAMES = [
  { key: '1D', label: '1D', groupSize: 1 },
  { key: '20s', label: '20s', groupSize: 5 },
  { key: '1m', label: '1m', groupSize: 15 },
  { key: '5m', label: '5m', groupSize: 75 },
  { key: '15m', label: '15m', groupSize: 225 },
] as const;
export type TimeframeKey = (typeof TIMEFRAMES)[number]['key'];

export default function PriceChart({
  candles,
  height = 340,
  timeframe,
  onTimeframeChange,
  entryPrice,
  slPrice,
  tpPrice,
  beActive,
  trades = [],
}: {
  candles: Candle[];
  height?: number;
  timeframe: TimeframeKey;
  onTimeframeChange: (tf: TimeframeKey) => void;
  entryPrice?: number | null;
  slPrice?: number | null;
  tpPrice?: number | null;
  beActive?: boolean;
  trades?: TradeMarker[];
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const sma20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const sma50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const slLineRef = useRef<IPriceLine | null>(null);
  const tpLineRef = useRef<IPriceLine | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Mirrors of the latest props, read by the mount effect (which must not
  // depend on candles/entryPrice/etc. directly — it should only ever run once).
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const linesRef = useRef({ entryPrice, slPrice, tpPrice, beActive });
  linesRef.current = { entryPrice, slPrice, tpPrice, beActive };
  const tradesRef = useRef(trades);
  tradesRef.current = trades;

  // Created ONCE on mount and kept alive for the component's whole lifetime —
  // including across fullscreen toggles. Toggling fullscreen only changes the
  // wrapper's CSS (position/size); the ResizeObserver below picks up the
  // resulting size change and calls chart.resize(), so the same chart
  // instance (and your pan/zoom state) survives the transition instead of
  // being destroyed and rebuilt from scratch.
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

    // Seed immediately with whatever data/lines we currently have.
    if (candlesRef.current.length) {
      candleSeries.setData(candlesRef.current.map((c) => ({ time: c.time as any, open: c.o, high: c.h, low: c.l, close: c.c })));
      sma20Series.setData(candlesRef.current.filter((c) => c.sma20 != null).map((c) => ({ time: c.time as any, value: c.sma20 as number })));
      sma50Series.setData(candlesRef.current.filter((c) => c.sma50 != null).map((c) => ({ time: c.time as any, value: c.sma50 as number })));
      chart.timeScale().scrollToRealTime();
    }
    if (linesRef.current.entryPrice != null) {
      entryLineRef.current = candleSeries.createPriceLine({
        price: linesRef.current.entryPrice, color: TV.entry, lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'Entry',
      });
    }
    if (linesRef.current.slPrice != null) {
      slLineRef.current = candleSeries.createPriceLine({
        price: linesRef.current.slPrice, color: linesRef.current.beActive ? TV.be : TV.sl, lineWidth: 1, lineStyle: 3, axisLabelVisible: true,
        title: linesRef.current.beActive ? 'SL (BE)' : 'SL',
      });
    }
    if (linesRef.current.tpPrice != null) {
      tpLineRef.current = candleSeries.createPriceLine({
        price: linesRef.current.tpPrice, color: TV.tp, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'TP',
      });
    }

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight, true);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [candles]);

  // entry / SL / TP lines — updated whenever the position changes
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const series = candleSeriesRef.current;

    if (entryLineRef.current) { series.removePriceLine(entryLineRef.current); entryLineRef.current = null; }
    if (slLineRef.current) { series.removePriceLine(slLineRef.current); slLineRef.current = null; }
    if (tpLineRef.current) { series.removePriceLine(tpLineRef.current); tpLineRef.current = null; }

    if (entryPrice != null) {
      entryLineRef.current = series.createPriceLine({
        price: entryPrice, color: TV.entry, lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'Entry',
      });
    }
    if (slPrice != null) {
      slLineRef.current = series.createPriceLine({
        price: slPrice, color: beActive ? TV.be : TV.sl, lineWidth: 1, lineStyle: 3, axisLabelVisible: true,
        title: beActive ? 'SL (BE)' : 'SL',
      });
    }
    if (tpPrice != null) {
      tpLineRef.current = series.createPriceLine({
        price: tpPrice, color: TV.tp, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'TP',
      });
    }
  }, [entryPrice, slPrice, tpPrice, beActive]);

  // Persistent buy/sell markers — one per executed trade, kept on the chart
  // permanently (unlike the entry/SL/TP lines above, which only reflect the
  // currently open position). This never touches pan/zoom.
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
      <div style={{ position: 'relative', flex: 1, width: '100%', height: fullscreen ? undefined : height, minHeight: fullscreen ? 0 : height }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
    </div>
  );
}