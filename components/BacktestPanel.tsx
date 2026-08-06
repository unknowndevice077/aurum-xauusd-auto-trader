'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { History, Loader2 } from 'lucide-react';
import { THEME, FONT_SERIF, FONT_MONO, FONT_SANS } from '../lib/theme';
import { RISK_PRESETS, DEFAULT_START_CASH_FALLBACK, DEFAULT_LOT_OZ } from '../lib/riskPresets';
import { runBacktest, type BacktestResult } from '../lib/backtest';
import { fmtUSD, fmtOz } from '../lib/helpers';

// A standalone, self-contained view — its own risk preset / capital / lot
// size, independent from whatever the Live or Always-On tabs are currently
// set to. This is a what-if research tool, not another instance of the bot.
export default function BacktestPanel() {
  const [dailyHistory, setDailyHistory] = useState<{ t: number; p: number }[]>([]);
  const [riskKey, setRiskKey] = useState('balanced');
  const [startCash, setStartCash] = useState(DEFAULT_START_CASH_FALLBACK);
  const [startCashInput, setStartCashInput] = useState(String(DEFAULT_START_CASH_FALLBACK));
  const [lotOz, setLotOz] = useState(DEFAULT_LOT_OZ);
  const [lotOzInput, setLotOzInput] = useState(String(DEFAULT_LOT_OZ));
  const [useKelly, setUseKelly] = useState(false);
  const [year, setYear] = useState('all');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history?range=25y');
        const json = await res.json();
        if (!cancelled && !json.error && Array.isArray(json.points) && json.points.length > 0) {
          setDailyHistory(json.points);
        }
      } catch {
        // Non-critical — the panel just shows "loading" indefinitely if this fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    for (const pt of dailyHistory) years.add(new Date(pt.t * 1000).getUTCFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [dailyHistory]);

  const handleApplyLotOz = useCallback(() => {
    const val = parseFloat(lotOzInput);
    if (Number.isFinite(val) && val > 0) {
      setLotOz(val);
      setLotOzInput(String(val));
    } else {
      setLotOzInput(String(lotOz));
    }
  }, [lotOzInput, lotOz]);

  const handleApplyStartCash = useCallback(() => {
    const val = parseFloat(startCashInput);
    if (Number.isFinite(val) && val > 0) {
      setStartCash(val);
      setStartCashInput(String(val));
    } else {
      setStartCashInput(String(startCash));
    }
  }, [startCashInput, startCash]);

  const handleRun = useCallback(() => {
    setError('');
    if (dailyHistory.length === 0) {
      setError('No historical data loaded yet — try again in a moment.');
      return;
    }
    setRunning(true);
    setTimeout(() => {
      try {
        let from: number | undefined;
        let to: number | undefined;
        if (year !== 'all') {
          const y = parseInt(year, 10);
          from = Math.floor(new Date(Date.UTC(y, 0, 1)).getTime() / 1000);
          to = Math.floor(new Date(Date.UTC(y + 1, 0, 1)).getTime() / 1000) - 1;
        }
        const res = runBacktest(dailyHistory, { riskKey, startCash, lotOz, useKelly, from, to });
        if (!res) {
          setError(
            year !== 'all'
              ? `Not enough historical data in ${year} to backtest (need 55+ daily bars).`
              : 'Not enough historical data to backtest (need 55+ daily bars).'
          );
          setResult(null);
        } else {
          setResult(res);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Backtest failed');
      } finally {
        setRunning(false);
      }
    }, 10);
  }, [dailyHistory, riskKey, startCash, lotOz, useKelly, year]);

  return (
    <div
      style={{
        background: THEME.bg,
        color: THEME.text,
        fontFamily: FONT_SANS,
        padding: '24px',
        borderRadius: '12px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '10px',
          borderBottom: `1px solid ${THEME.hairline}`,
          paddingBottom: '16px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontFamily: FONT_SERIF,
            fontSize: '26px',
            letterSpacing: '0.02em',
            color: THEME.goldBright,
          }}
        >
          <History size={20} /> AURUM — Backtest
        </div>
        <div style={{ fontSize: '12px', color: THEME.muted }}>
          Real GC=F daily history &middot; what-if analysis, no live/server state involved
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.hairline}`,
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '16px',
        }}
      >
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
          <div>
            <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>
              Risk preset
            </label>
            <select
              value={riskKey}
              onChange={(e) => setRiskKey(e.target.value)}
              style={{
                background: THEME.panelAlt,
                color: THEME.text,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontFamily: FONT_SANS,
                fontSize: '13px',
              }}
            >
              {Object.entries(RISK_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>
              Starting capital ($)
            </label>
            <input
              className="aurum-input"
              type="number"
              min={1}
              value={startCashInput}
              onChange={(e) => setStartCashInput(e.target.value)}
              onBlur={handleApplyStartCash}
              style={{
                width: '120px',
                background: THEME.panel,
                color: THEME.text,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '13px',
                fontFamily: FONT_MONO,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>
              Lot size (oz)
            </label>
            <input
              className="aurum-input"
              type="number"
              min={0.00001}
              step="0.001"
              value={lotOzInput}
              onChange={(e) => setLotOzInput(e.target.value)}
              onBlur={handleApplyLotOz}
              style={{
                width: '110px',
                background: THEME.panel,
                color: THEME.text,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '13px',
                fontFamily: FONT_MONO,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>
              Year
            </label>
            <select
              value={year}
              onChange={(e) => setYear(e.target.value)}
              style={{
                background: THEME.panelAlt,
                color: THEME.text,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontFamily: FONT_MONO,
                fontSize: '12px',
              }}
            >
              <option value="all">All available history</option>
              {availableYears.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: THEME.muted, cursor: 'pointer', paddingBottom: '8px' }}>
            <input type="checkbox" checked={useKelly} onChange={(e) => setUseKelly(e.target.checked)} />
            Kelly can shrink lot
          </label>
          <button
            onClick={handleRun}
            disabled={running || dailyHistory.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: THEME.gold,
              color: '#1A1508',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 14px',
              fontFamily: FONT_SANS,
              fontSize: '13px',
              fontWeight: 500,
              cursor: running || dailyHistory.length === 0 ? 'not-allowed' : 'pointer',
              opacity: running || dailyHistory.length === 0 ? 0.6 : 1,
            }}
          >
            {running ? <Loader2 size={14} className="spin" /> : <History size={14} />}
            {running ? 'Running…' : 'Run backtest'}
          </button>
        </div>
        <div style={{ fontSize: '11px', color: THEME.muted }}>
          Replays the same strategy (technical scoring, the fixed-lot sizing above, optional
          Kelly, the regime brain, breakeven &amp; trailing stop) against real historical GC=F
          daily closes. Two honest limits: stop/take-profit checks use daily closes, not intraday
          highs and lows, and there&apos;s no historical news feed, so this always runs
          math-only. A single position at a time plus a selective entry threshold naturally means
          low trade counts — this is a patient, one-position system, not a high-frequency one, and
          bigger lot sizes amplify existing swings rather than creating more winning trades.
        </div>
      </div>

      {error && (
        <div style={{ fontSize: '12px', color: THEME.loss, marginBottom: '16px' }}>{error}</div>
      )}

      {!result && !error && (
        <div style={{ fontSize: '12px', color: THEME.muted }}>
          {dailyHistory.length === 0
            ? 'Loading historical data…'
            : `${dailyHistory.length} days of real GC=F history loaded — click "Run backtest" to see how this strategy would have performed.`}
        </div>
      )}

      {result && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '10px',
              marginBottom: '14px',
            }}
          >
            {[
              {
                label: 'Total return',
                value: `${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}%`,
                color: result.totalReturnPct >= 0 ? THEME.gain : THEME.loss,
              },
              { label: 'Final equity', value: `$${fmtUSD(result.finalEquity)}` },
              { label: 'Trades', value: `${result.stats.totalTrades}` },
              {
                label: 'Win rate',
                value: `${(result.stats.winRate * 100).toFixed(0)}%`,
                sub: result.winRateCI
                  ? `95% CI ${(result.winRateCI.low * 100).toFixed(0)}–${(result.winRateCI.high * 100).toFixed(0)}%`
                  : undefined,
              },
              {
                label: 'Sharpe (ann.)',
                value: result.stats.sharpe != null ? result.stats.sharpe.toFixed(2) : '--',
              },
              {
                label: 'Max drawdown',
                value: result.stats.maxDrawdownPct != null ? `${result.stats.maxDrawdownPct.toFixed(2)}%` : '--',
                color: THEME.loss,
              },
            ].map((kpi) => (
              <div
                key={kpi.label}
                style={{
                  background: THEME.panel,
                  border: `1px solid ${THEME.hairline}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: '10px', color: THEME.muted, marginBottom: '2px' }}>{kpi.label}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: '14px', color: kpi.color || THEME.text }}>
                  {kpi.value}
                </div>
                {kpi.sub && (
                  <div style={{ fontFamily: FONT_MONO, fontSize: '10px', color: THEME.muted }}>{kpi.sub}</div>
                )}
              </div>
            ))}
          </div>

          {result.stats.totalTrades > 0 && result.stats.totalTrades < 30 && (
            <div
              style={{
                fontSize: '11px',
                color: THEME.muted,
                background: THEME.panel,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 10px',
                marginBottom: '10px',
              }}
            >
              Only {result.stats.totalTrades} trades &mdash; below ~30, win rate/Sharpe are not
              statistically reliable (see the win rate&apos;s wide confidence interval above).
              Treat these numbers as a rough signal, not a verdict.
            </div>
          )}

          {result.anomalies.length > 0 && (
            <div
              style={{
                fontSize: '11px',
                color: THEME.muted,
                background: THEME.panel,
                border: `1px solid ${THEME.gold}`,
                borderRadius: '6px',
                padding: '8px 10px',
                marginBottom: '10px',
              }}
            >
              <strong style={{ color: THEME.text }}>
                {result.anomalies.length} unusually large single-day move
                {result.anomalies.length === 1 ? '' : 's'} in this data
              </strong>{' '}
              (&gt;8% in a day &mdash; larger than gold has moved in one real session even during
              2008 or 2020):{' '}
              {result.anomalies.slice(0, 5).map((a, i) => (
                <span key={a.t}>
                  {i > 0 ? ', ' : ''}
                  {new Date(a.t * 1000).toLocaleDateString()} ({a.changePct >= 0 ? '+' : ''}
                  {a.changePct.toFixed(1)}%)
                </span>
              ))}
              {result.anomalies.length > 5 ? '…' : ''}. Could be a real move or an artifact of
              Yahoo&apos;s free GC=F feed not being adjusted for futures contract rollovers &mdash;
              shown here rather than silently altered, since telling the two apart from price
              alone isn&apos;t reliable.
            </div>
          )}

          {result.dateRange && (
            <div style={{ fontSize: '10px', color: THEME.muted, marginBottom: '10px' }}>
              {new Date(result.dateRange.from * 1000).toLocaleDateString()} &ndash;{' '}
              {new Date(result.dateRange.to * 1000).toLocaleDateString()} &middot;{' '}
              {result.barsTraded} daily bars
            </div>
          )}

          <div
            style={{
              background: THEME.panel,
              border: `1px solid ${THEME.hairline}`,
              borderRadius: '8px',
              padding: '14px',
              marginBottom: '16px',
            }}
          >
            <div style={{ height: '100px', marginBottom: result.trades.length > 0 ? '10px' : 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={result.equityCurve}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={['auto', 'auto']} tick={{ fill: THEME.muted, fontSize: 10 }} width={50} />
                  <Tooltip
                    contentStyle={{ background: THEME.panelAlt, border: `1px solid ${THEME.hairline}`, fontSize: '12px' }}
                    labelFormatter={(t: number) => new Date(t * 1000).toLocaleDateString()}
                    formatter={(v: number) => [`$${fmtUSD(v)}`, 'Equity']}
                  />
                  <Area type="monotone" dataKey="value" stroke={THEME.gold} fill={THEME.gold} fillOpacity={0.12} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {result.trades.length > 0 ? (
              <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
                {result.trades.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 0',
                      borderBottom: `1px solid ${THEME.hairline}`,
                      gap: '10px',
                      fontSize: '11px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          background: t.side === 'BUY' ? 'rgba(91,146,121,0.15)' : 'rgba(181,83,60,0.15)',
                          color: t.side === 'BUY' ? THEME.gain : THEME.loss,
                          flexShrink: 0,
                        }}
                      >
                        {t.side}
                      </span>
                      <span
                        style={{
                          color: THEME.muted,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.time} &middot; {t.reasoning}
                      </span>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: FONT_MONO }}>
                        {fmtOz(t.oz)} oz @ ${fmtUSD(t.price)}
                      </div>
                      {typeof t.pnl === 'number' && (
                        <div style={{ fontFamily: FONT_MONO, color: t.pnl >= 0 ? THEME.gain : THEME.loss }}>
                          {t.pnl >= 0 ? '+' : '-'}${fmtUSD(Math.abs(t.pnl))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: THEME.muted }}>
                No trades fired over this history at the current risk preset &mdash; try a less
                conservative preset or a bigger lot size relative to your starting capital.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
