'use client';

import { useState } from 'react';
import { Radio, LineChart, History } from 'lucide-react';
import AurumTerminal from '../components/AurumTerminal';
import AlwaysOnBot from '../components/AlwaysOnBot';
import BacktestPanel from '../components/BacktestPanel';
import { THEME, FONT_SANS } from '../lib/theme';

type TabKey = 'always-on' | 'local' | 'backtest';

const TABS: { key: TabKey; label: string; icon: typeof Radio }[] = [
  { key: 'always-on', label: 'Always-On Bot', icon: Radio },
  { key: 'local', label: 'Local Simulation', icon: LineChart },
  { key: 'backtest', label: 'Backtest', icon: History },
];

export default function Home() {
  const [tab, setTab] = useState<TabKey>('always-on');

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      <nav
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '20px',
          borderBottom: `1px solid ${THEME.hairline}`,
          paddingBottom: '12px',
        }}
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={active ? 'page' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: active ? THEME.gold : 'transparent',
                color: active ? '#1A1508' : THEME.muted,
                border: `1px solid ${active ? THEME.gold : THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 16px',
                fontFamily: FONT_SANS,
                fontSize: '13px',
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </nav>

      {tab === 'always-on' && <AlwaysOnBot />}
      {tab === 'local' && <AurumTerminal />}
      {tab === 'backtest' && <BacktestPanel />}
    </main>
  );
}
