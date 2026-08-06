import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getState, setState, freshPortfolio } from '../../../lib/serverState';
import { RISK_PRESETS, MAX_LEVERAGE } from '../../../lib/riskPresets';

export const dynamic = 'force-dynamic';

const ControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('reset'), startCash: z.number().min(1).max(10_000_000).optional() }),
  z.object({ action: z.literal('setRiskKey'), riskKey: z.string() }),
  z.object({ action: z.literal('setLotOz'), lotOz: z.number().positive().max(1000) }),
  z.object({ action: z.literal('setLeverage'), leverage: z.number().min(1).max(MAX_LEVERAGE) }),
  z.object({ action: z.literal('setUseKelly'), useKelly: z.boolean() }),
]);

// Public control surface for the always-on bot — start/pause/reset and
// change the risk preset. There's no auth model for this whole app (it's a
// personal paper-trading tool, not multi-tenant), so this is intentionally
// unauthenticated like the rest of the UI's controls; it can't move real
// money, only this shared simulated portfolio.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = ControlSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.format() },
        { status: 400 }
      );
    }

    const state = await getState();
    const input = parsed.data;

    if (input.action === 'start') {
      await setState({ ...state, botRunning: true });
    } else if (input.action === 'pause') {
      await setState({ ...state, botRunning: false });
    } else if (input.action === 'reset') {
      const startCash = input.startCash ?? state.startCash;
      await setState({
        ...state,
        startCash,
        portfolio: freshPortfolio(startCash),
        equityCurve: [],
        consecutiveLosses: 0,
        botRunning: false,
      });
    } else if (input.action === 'setRiskKey') {
      if (!RISK_PRESETS[input.riskKey]) {
        return NextResponse.json({ error: `Unknown risk preset "${input.riskKey}"` }, { status: 400 });
      }
      await setState({ ...state, riskKey: input.riskKey });
    } else if (input.action === 'setLotOz') {
      await setState({ ...state, lotOz: input.lotOz });
    } else if (input.action === 'setLeverage') {
      await setState({ ...state, leverage: input.leverage });
    } else if (input.action === 'setUseKelly') {
      await setState({ ...state, useKelly: input.useKelly });
    }

    const next = await getState();
    return NextResponse.json(next);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Control request failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
