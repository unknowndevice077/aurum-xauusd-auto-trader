'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Play, Pause, RotateCcw, Radio, AlertTriangle, Newspaper } from 'lucide-react';
import { THEME, FONT_SERIF, FONT_MONO, FONT_SANS } from '../lib/theme';
import { RISK_PRESETS, MAX_LEVERAGE } from '../lib/riskPresets';
import { fmtUSD, fmtOz } from '../lib/helpers';
import type { GlobalBotState } from '../lib/serverState';

const POLL_MS = 5000;

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function AlwaysOnBot() {
  const [state, setState] = useState<(GlobalBotState & { persistent: boolean }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [startCashInput, setStartCashInput] = useState('10000');
  const [lotOzInput, setLotOzInput] = useState('0.05');
  const lotOzSynced = React.useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load state');
      setState(data);
      setError('');
      // Sync the lot-size input from server state once on first load only —
      // afterward it's the user's own in-progress edit, not something to
      // overwrite on every 5s poll.
      if (!lotOzSynced.current && typeof data.lotOz === 'number') {
        setLotOzInput(String(data.lotOz));
        lotOzSynced.current = true;
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load state');
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const sendControl = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Control request failed');
        setState(data);
        setError('');
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Control request failed');
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const handleReset = useCallback(() => {
    const val = parseFloat(startCashInput);
    sendControl({ action: 'reset', startCash: Number.isFinite(val) && val > 0 ? val : undefined });
  }, [startCashInput, sendControl]);

  const handleApplyLotOz = useCallback(() => {
    const val = parseFloat(lotOzInput);
    if (Number.isFinite(val) && val > 0) {
      sendControl({ action: 'setLotOz', lotOz: val });
    } else if (state) {
      setLotOzInput(String(state.lotOz));
    }
  }, [lotOzInput, sendControl, state]);

  if (!state) {
    return (
      <div
        style={{
          background: THEME.bg,
          color: THEME.muted,
          fontFamily: FONT_SANS,
          padding: '24px',
          borderRadius: '12px',
          fontSize: '13px',
        }}
      >
        {error ? `Failed to load always-on bot: ${error}` : 'Loading always-on bot state…'}
      </div>
    );
  }

  const equityValue = state.price != null ? state.portfolio.cash + state.portfolio.oz * state.price : state.portfolio.cash;
  const pnl = equityValue - state.startCash;
  const pnlPct = state.startCash > 0 ? (pnl / state.startCash) * 100 : 0;
  const neverTicked = state.lastTickAt == null;
  const openPositionPnlPct =
    state.portfolio.oz > 0 && state.portfolio.entryPrice && state.price
      ? ((state.price - state.portfolio.entryPrice) / state.portfolio.entryPrice) * 100
      : null;

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
          justifyContent: 'space-between',
          alignItems: 'baseline',
          borderBottom: `1px solid ${THEME.hairline}`,
          paddingBottom: '16px',
          marginBottom: '16px',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div>
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
            <Radio size={20} /> AURUM — Always-On
          </div>
          <div style={{ fontSize: '12px', color: THEME.muted, marginTop: '2px' }}>
            Single shared bot, ticked server-side by an external cron &middot; {state.dataSourceLabel}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: state.botRunning ? THEME.gain : THEME.muted,
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: '12px', fontFamily: FONT_MONO, color: THEME.muted }}>
            {state.botRunning ? 'RUNNING' : 'PAUSED'} &middot; last ticked {timeAgo(state.lastTickAt)}
          </span>
        </div>
      </div>

      {(!state.persistent || neverTicked) && (
        <div
          style={{
            background: THEME.panelAlt,
            border: `1px solid ${THEME.gold}`,
            borderRadius: '8px',
            padding: '12px 14px',
            fontSize: '12px',
            color: THEME.text,
            marginBottom: '20px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={16} color={THEME.gold} style={{ flexShrink: 0, marginTop: '1px' }} />
          <div>
            {!state.persistent && (
              <div style={{ marginBottom: neverTicked ? '6px' : 0 }}>
                <strong>No persistent database configured.</strong> State is held in server memory
                only — it will reset whenever the server cold-starts. Add{' '}
                <code>UPSTASH_REDIS_REST_URL</code> and <code>UPSTASH_REDIS_REST_TOKEN</code> as
                Vercel environment variables (free tier at upstash.com) for this to actually
                survive.
              </div>
            )}
            {neverTicked && (
              <div>
                <strong>No cron has hit this yet.</strong> Set up a free scheduled job at{' '}
                cron-job.org (or similar) to call{' '}
                <code>/api/tick?secret=YOUR_CRON_SECRET</code> every 1–5 minutes — that&apos;s what
                actually advances the bot.
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: '12px', color: THEME.loss, marginBottom: '16px' }}>{error}</div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => sendControl({ action: state.botRunning ? 'pause' : 'start' })}
          disabled={busy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: state.botRunning ? THEME.panelAlt : THEME.gold,
            color: state.botRunning ? THEME.text : '#1A1508',
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 16px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
            fontWeight: 500,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {state.botRunning ? <Pause size={14} /> : <Play size={14} />}
          {state.botRunning ? 'Pause bot' : 'Start bot'}
        </button>

        <select
          value={state.riskKey}
          onChange={(e) => sendControl({ action: 'setRiskKey', riskKey: e.target.value })}
          disabled={busy}
          style={{
            background: THEME.panelAlt,
            color: THEME.text,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 12px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
          }}
        >
          {Object.entries(RISK_PRESETS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label} risk
            </option>
          ))}
        </select>

        <input
          className="aurum-input"
          type="number"
          min={1}
          value={startCashInput}
          onChange={(e) => setStartCashInput(e.target.value)}
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
        <button
          onClick={handleReset}
          disabled={busy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            color: THEME.muted,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 16px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          <RotateCcw size={14} /> Reset (uses $ above)
        </button>
      </div>

      {/* Lot size / Kelly */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: '11px', color: THEME.muted }}>Lot size (oz)</label>
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
        <label style={{ fontSize: '11px', color: THEME.muted }} title="1x = full notional in cash. Raising this lets a lot size that would otherwise be unaffordable actually trade, using only a fraction of its value as margin.">
          Leverage
        </label>
        <select
          value={state.leverage}
          onChange={(e) => sendControl({ action: 'setLeverage', leverage: Number(e.target.value) })}
          disabled={busy}
          style={{
            background: THEME.panel,
            color: THEME.text,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 10px',
            fontSize: '13px',
            fontFamily: FONT_MONO,
          }}
        >
          {[1, 2, 5, 10, 20].filter((l) => l <= MAX_LEVERAGE).map((l) => (
            <option key={l} value={l}>
              {l}x
            </option>
          ))}
        </select>
        {state.price != null && (
          <span style={{ fontSize: '11px', color: THEME.muted, fontFamily: FONT_MONO }}>
            ≈ ${fmtUSD(((parseFloat(lotOzInput) || 0) * state.price) / (state.leverage || 1))} margin per trade
            {state.leverage > 1
              ? ` (notional $${fmtUSD((parseFloat(lotOzInput) || 0) * state.price, 0)} at ${state.leverage}x)`
              : ''}
          </span>
        )}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: THEME.muted,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={state.useKelly}
            onChange={(e) => sendControl({ action: 'setUseKelly', useKelly: e.target.checked })}
            disabled={busy}
          />
          Let Kelly sizing shrink the lot after a losing streak
        </label>
      </div>

      {/* Metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        {[
          { label: 'Portfolio value', value: `$${fmtUSD(equityValue)}` },
          { label: 'Cash', value: `$${fmtUSD(state.portfolio.cash)}` },
          { label: 'Gold held', value: `${fmtOz(state.portfolio.oz)} oz` },
          {
            label: 'P&L',
            value: `${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))}`,
            color: pnl >= 0 ? THEME.gain : THEME.loss,
            sub: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
          },
        ].map((m) => (
          <div
            key={m.label}
            style={{
              background: THEME.panel,
              border: `1px solid ${THEME.hairline}`,
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {m.label}
            </div>
            <div style={{ fontFamily: FONT_SERIF, fontSize: '22px', color: m.color || THEME.text }}>{m.value}</div>
            {m.sub && (
              <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: m.color || THEME.muted }}>{m.sub}</div>
            )}
          </div>
        ))}
      </div>

      {/* Open position */}
      {state.portfolio.oz > 0 && state.portfolio.entryPrice && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            background: THEME.panelAlt,
            border: `1px solid ${THEME.gold}`,
            borderRadius: '8px',
            padding: '10px 14px',
            marginBottom: '16px',
            fontSize: '12px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontFamily: FONT_MONO, color: THEME.gold, fontWeight: 600 }}>OPEN POSITION</span>
          <span style={{ color: THEME.muted }}>
            Long {fmtOz(state.portfolio.oz)} oz @ ${fmtUSD(state.portfolio.entryPrice)}
          </span>
          {openPositionPnlPct != null && (
            <span style={{ fontFamily: FONT_MONO, color: openPositionPnlPct >= 0 ? THEME.gain : THEME.loss }}>
              {openPositionPnlPct >= 0 ? '+' : ''}
              {openPositionPnlPct.toFixed(2)}%
            </span>
          )}
          <span style={{ fontFamily: FONT_MONO, color: THEME.muted }}>SL ${fmtUSD(state.portfolio.slPrice)}</span>
          <span style={{ fontFamily: FONT_MONO, color: THEME.gain }}>TP ${fmtUSD(state.portfolio.tpPrice)}</span>
        </div>
      )}

      {/* News */}
      {state.news && (
        <div
          style={{
            background: THEME.panel,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '8px',
            padding: '14px',
            marginBottom: '16px',
            fontSize: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: THEME.muted, marginBottom: '6px' }}>
            <Newspaper size={13} /> Last server news read &middot; {state.news.providerLabel}
          </div>
          <div>{state.news.summary || state.news.key_driver}</div>
        </div>
      )}

      {/* Equity curve */}
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.hairline}`,
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '16px',
        }}
      >
        <div style={{ fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
          Equity curve
        </div>
        <div style={{ height: '110px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={state.equityCurve}>
              <XAxis dataKey="t" hide />
              <YAxis domain={['auto', 'auto']} tick={{ fill: THEME.muted, fontSize: 10 }} width={50} />
              <Tooltip
                contentStyle={{ background: THEME.panelAlt, border: `1px solid ${THEME.hairline}`, fontSize: '12px' }}
                labelFormatter={(t: number) => new Date(t).toLocaleString()}
                formatter={(v: number) => [`$${fmtUSD(v)}`, 'Value']}
              />
              <Area type="monotone" dataKey="value" stroke={THEME.gold} fill={THEME.gold} fillOpacity={0.12} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Trade ledger */}
      <div style={{ background: THEME.panel, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '14px' }}>
        <div style={{ fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
          Trade ledger
        </div>
        {state.portfolio.trades.length === 0 ? (
          <div style={{ fontSize: '12px', color: THEME.muted }}>No trades yet.</div>
        ) : (
          <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
            {state.portfolio.trades.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: `1px solid ${THEME.hairline}`,
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '11px',
                      padding: '2px 8px',
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
                      fontSize: '12px',
                      color: THEME.muted,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {t.reasoning}
                  </span>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: '12px' }}>
                    {fmtOz(t.oz)} oz @ ${fmtUSD(t.price)}
                  </div>
                  {typeof t.pnl === 'number' && (
                    <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: t.pnl >= 0 ? THEME.gain : THEME.loss }}>
                      {t.pnl >= 0 ? '+' : '-'}${fmtUSD(Math.abs(t.pnl))}
                    </div>
                  )}
                  <div style={{ fontFamily: FONT_MONO, fontSize: '10px', color: THEME.muted }}>{t.time}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
