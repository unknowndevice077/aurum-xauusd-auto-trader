import { NextResponse } from 'next/server';

// Yahoo Finance's chart endpoint is unauthenticated and CORS-blocked from the browser,
// so this runs server-side and the client just calls our own /api/history.
export async function GET() {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1y&interval=1d';
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

    return NextResponse.json({ points, source: 'Yahoo Finance GC=F, 1y daily' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'History fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}