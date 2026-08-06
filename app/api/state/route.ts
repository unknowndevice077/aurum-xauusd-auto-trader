import { NextResponse } from 'next/server';
import { getState, hasPersistentStore, getLastStoreError } from '../../../lib/serverState';

export const dynamic = 'force-dynamic';

// Public, read-only — the frontend polls this to display the always-on
// bot's current state. No secrets in the payload, so no auth needed.
//
// `storeError` reports a persistence problem (bad Upstash URL/token, network
// failure) without failing the request: the bot still has usable state, it
// just won't survive a cold start, and the UI can say so plainly. Returning
// 500 here instead would take the whole panel down and explain nothing.
export async function GET() {
  try {
    const state = await getState();
    return NextResponse.json({
      ...state,
      persistent: hasPersistentStore,
      storeError: getLastStoreError(),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to load bot state';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
