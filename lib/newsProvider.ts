// ─── Server-Side News Fetch (for the always-on cron bot) ──────────────────
// Deliberately separate from app/api/news/route.ts (the client's manual
// "News & macro" lookup, which can take a client-supplied API key override).
// This only ever uses server environment variables — an unattended cron job
// has no user in the loop to supply a key, and shouldn't trust one anyway.
// Returns null (never throws) so a news outage just leaves the bot math-only
// for that tick rather than failing the whole cron run.

import type { ServerNews } from './serverState';

const SYSTEM_WITH_SEARCH =
  'Gold market analyst. Web-search news from last 24-48h affecting XAU/USD (dollar strength, Fed, inflation, yields). ' +
  'Also self-rate confidence 0-1 in this read. Reply with ONLY raw JSON, no markdown: ' +
  '{"sentiment_score":-1to1,"confidence":0to1,"bias":"bullish|bearish|neutral","summary":"<20 words","key_driver":"<6 words"}';

const SYSTEM_NO_SEARCH =
  'Gold market analyst. Based on general knowledge of typical XAU/USD drivers (dollar strength, Fed policy, inflation, yields), ' +
  'give a plausible current-conditions estimate. Since this is not live search, self-rate confidence low-to-moderate (0.2-0.5). ' +
  'Reply with ONLY raw JSON, no markdown: ' +
  '{"sentiment_score":-1to1,"confidence":0to1,"bias":"bullish|bearish|neutral","summary":"<20 words","key_driver":"<6 words"}';

function parseNewsJson(text: string, providerLabel: string): ServerNews | null {
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : clean);
    return {
      sentiment_score: Math.max(-1, Math.min(1, Number(parsed.sentiment_score) || 0)),
      confidence: Number.isFinite(Number(parsed.confidence))
        ? Math.max(0, Math.min(1, Number(parsed.confidence)))
        : 0.5,
      bias: parsed.bias === 'bullish' || parsed.bias === 'bearish' ? parsed.bias : 'neutral',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      key_driver: typeof parsed.key_driver === 'string' ? parsed.key_driver : '',
      ts: Date.now(),
      providerLabel,
    };
  } catch {
    return null;
  }
}

async function callAnthropic(apiKey: string): Promise<ServerNews | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: SYSTEM_WITH_SEARCH,
      messages: [{ role: 'user', content: 'Gold price drivers right now. JSON only.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  const content = (data?.content || []) as Array<{ type: string; text?: string }>;
  const text = content
    .map((b) => (b.type === 'text' ? b.text || '' : ''))
    .filter(Boolean)
    .join('\n');
  return parseNewsJson(text, 'Claude (Anthropic)');
}

async function callChatCompletions(
  apiKey: string,
  url: string,
  model: string,
  label: string
): Promise<ServerNews | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_NO_SEARCH },
        { role: 'user', content: 'Gold price drivers right now. JSON only.' },
      ],
      max_tokens: 400,
    }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content || '';
  return parseNewsJson(text, label);
}

// Tries providers in priority order — Anthropic gets live web search, the
// others are general-knowledge estimates. Uses whichever server key is
// actually configured; returns null if none are set (bot stays math-only,
// same default as the local/live client mode).
export async function fetchServerNews(): Promise<ServerNews | null> {
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await callAnthropic(process.env.ANTHROPIC_API_KEY);
      if (r) return r;
    }
    if (process.env.OPENAI_API_KEY) {
      const r = await callChatCompletions(
        process.env.OPENAI_API_KEY,
        'https://api.openai.com/v1/chat/completions',
        'gpt-5.5',
        'OpenAI (GPT)'
      );
      if (r) return r;
    }
    if (process.env.XAI_API_KEY) {
      const r = await callChatCompletions(
        process.env.XAI_API_KEY,
        'https://api.x.ai/v1/chat/completions',
        'grok-4',
        'Grok (xAI)'
      );
      if (r) return r;
    }
  } catch {
    // Swallow — a news outage just means this tick runs math-only.
  }
  return null;
}
