import { NextRequest, NextResponse } from 'next/server';
import { getState, setState, hasPersistentStore } from '../../../lib/serverState';
import { runOneTick } from '../../../lib/liveStep';

// Never statically optimize/cache this route — every call must do real work.
export const dynamic = 'force-dynamic';

// This is the endpoint an external scheduler (cron-job.org, GitHub Actions,
// etc.) hits on a schedule to advance the always-on bot by one tick. Guarded
// by a shared secret so random internet traffic can't spam trades.
async function handleTick(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = req.nextUrl.searchParams.get('secret') || req.headers.get('x-cron-secret');
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const state = await getState();
    const next = await runOneTick(state);
    await setState(next);
    return NextResponse.json({
      ok: true,
      persistent: hasPersistentStore,
      price: next.price,
      dataSourceLabel: next.dataSourceLabel,
      equity: next.price != null ? next.portfolio.cash + next.portfolio.oz * next.price : next.portfolio.cash,
      botRunning: next.botRunning,
      tradeCount: next.portfolio.trades.length,
      ts: next.lastTickAt,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Tick failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handleTick(req);
}

export async function POST(req: NextRequest) {
  return handleTick(req);
}
