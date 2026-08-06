import { NextRequest, NextResponse } from 'next/server';

// Deliberately excludes 'max': Yahoo silently switches to ~monthly
// granularity for that value even with interval=1d requested (verified —
// 'max' returned 267 points spanning 26 years, i.e. ~10/year; every
// explicit range up to 25y returns genuinely daily data, ~252/year, over
// essentially the same span). Every indicator in this app (RSI14, EMA12/26,
// ATR14, the anomaly-move threshold) is calibrated assuming daily bars, so
// silently getting monthly bars would quietly invalidate all of them.
const ALLOWED_RANGES = new Set(['1y', '2y', '5y', '10y', '25y']);

// Yahoo Finance's chart endpoint is unauthenticated and CORS-blocked from the browser,
// so this runs server-side and the client just calls our own /api/history.
// Defaults to 25y (the longest range confirmed to stay truly daily) so the
// backtest can offer a real year picker instead of being stuck with
// whatever the last 12 months happened to look like.
export async function GET(req: NextRequest) {
  try {
    const requested = req.nextUrl.searchParams.get('range') || '25y';
    const range = ALLOWED_RANGES.has(requested) ? requested : '25y';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=${range}&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AurumTerminal/1.0)' },
      next: { revalidate: 300 }, // cache for 5 minutes (was 1 hour)
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Yahoo Finance request failed (${res.status})` }, { status: 502 });
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const closes: number[] = result?.indicators?.quote?.[0]?.close || [];

    const points = timestamps
      .map((t, i) => ({ t, p: closes[i] }))
      .filter((pt) => pt.t && typeof pt.p === 'number' && !isNaN(pt.p));

    if (points.length === 0) {
      return NextResponse.json({ error: 'No historical data returned' }, { status: 502 });
    }

    return NextResponse.json({ points, source: `Yahoo Finance GC=F, ${range} daily` });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'History fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}