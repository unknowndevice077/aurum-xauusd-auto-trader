import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Live intraday gold, at a single consistent granularity.
//
// The Local Simulation seeds its indicator buffer from `points` and then
// polls this route to append each new bar. Both come from the same 1-minute
// GC=F series, which matters: an earlier version of that tab seeded from
// *daily* bars and then appended sub-minute synthetic ticks to the same
// array, so EMA12/26, RSI14 and the regression were being computed across
// two incompatible timescales at once.
//
// Yahoo's chart endpoint is unauthenticated but CORS-blocked in the browser,
// so this proxies it server-side, exactly like /api/history.
const YAHOO_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=1m';

export async function GET() {
  try {
    const res = await fetch(YAHOO_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AurumTerminal/1.0)' },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Yahoo Finance request failed (${res.status})` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    const timestamps: number[] = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const opens: (number | null)[] = quote.open || [];
    const highs: (number | null)[] = quote.high || [];
    const lows: (number | null)[] = quote.low || [];
    const closes: (number | null)[] = quote.close || [];

    // Full OHLC per bar, not just the close. Carrying only closes forces the
    // chart to synthesise candles where open == high == low == close, which
    // renders every bar as a flat dash with no body or wicks. The strategy
    // still consumes `p` (the close); the extra fields exist purely so the
    // chart can draw what actually happened inside each minute.
    //
    // Yahoo emits nulls for minutes with no prints; drop those rather than
    // carrying holes into the indicator windows.
    const all = timestamps
      .map((t, i) => ({
        t,
        p: closes[i],
        o: opens[i],
        h: highs[i],
        l: lows[i],
        c: closes[i],
      }))
      .filter(
        (b): b is { t: number; p: number; o: number; h: number; l: number; c: number } =>
          typeof b.t === 'number' &&
          typeof b.p === 'number' &&
          !isNaN(b.p) &&
          typeof b.o === 'number' &&
          typeof b.h === 'number' &&
          typeof b.l === 'number'
      );

    // Drop the final bar while the minute it covers is still forming. Yahoo
    // includes the in-progress candle, whose close keeps moving until the
    // minute ends — trading it would mean reacting to a half-built bar and
    // then never seeing its corrected value, since the replacement arrives
    // under the same timestamp the client has already consumed. Acting only
    // on closed candles is the standard discipline here.
    const nowSec = Math.floor(Date.now() / 1000);
    const points = all.filter((pt) => nowSec - pt.t >= 60);

    // `price` is for display and may include the in-progress minute, so the
    // header stays current even though the strategy only consumes closed
    // bars. Falls back to the last bar and then the previous close so a
    // request outside trading hours still returns a real number.
    const liveQuote = Number(meta?.regularMarketPrice);
    const lastBar = all.length ? all[all.length - 1].p : null;
    const prevClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    const price =
      Number.isFinite(liveQuote) && liveQuote > 0
        ? liveQuote
        : lastBar ?? (Number.isFinite(prevClose) ? prevClose : null);

    if (price == null || !(price > 100 && price < 100000)) {
      return NextResponse.json({ error: 'No usable gold price returned' }, { status: 502 });
    }

    return NextResponse.json({
      price,
      points,
      // 'REGULAR' while the pit is open; 'CLOSED'/'PRE'/'POST' otherwise. The
      // UI uses this to explain a flat chart instead of looking broken.
      marketState: meta?.marketState ?? null,
      source: 'Yahoo Finance GC=F, 1-minute',
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Live price fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
