import { NextResponse } from 'next/server';
import { getState, hasPersistentStore } from '../../../lib/serverState';

export const dynamic = 'force-dynamic';

// Public, read-only — the frontend polls this to display the always-on
// bot's current state. No secrets in the payload, so no auth needed.
export async function GET() {
  const state = await getState();
  return NextResponse.json({ ...state, persistent: hasPersistentStore });
}
