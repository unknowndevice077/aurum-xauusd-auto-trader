import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// ─── Input Validation Schema ──────────────────────────────────────────────
const NewsRequestSchema = z.object({
  providerKey: z.enum(['anthropic', 'openai', 'xai']).default('openai'),
  model: z.string().max(100).optional(),
  apiKey: z.string().max(500).optional(),
});

// ─── Rate Limiting (in-memory, per-deployment) ────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 requests per window per IP

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

// Server-side provider registry. Keys come from environment variables by
// default (set these in Vercel's Project Settings -> Environment Variables,
// or in .env.local for local dev). A per-request `apiKey` in the body is
// used as a fallback override and is never persisted or logged.
const PROVIDERS: Record<
  string,
  {
    label: string;
    defaultModel: string;
    endpoint: string;
    envVar: string;
    supportsWebSearch: boolean;
    buildRequest: (args: { apiKey: string; model: string; system: string; userText: string }) => {
      url: string;
      headers: Record<string, string>;
      body: unknown;
    };
    extractText: (data: unknown) => string;
  }
> = {
  anthropic: {
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-sonnet-4-6',
    endpoint: 'https://api.anthropic.com/v1/messages',
    envVar: 'ANTHROPIC_API_KEY',
    supportsWebSearch: true,
    buildRequest: ({ apiKey, model, system, userText }) => ({
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: 400,
        system,
        messages: [{ role: 'user', content: userText }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
    }),
    extractText: (data: unknown) => {
      const d = data as { content?: Array<{ type: string; text: string }> };
      return (d.content || []).map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    },
  },
  openai: {
    label: 'OpenAI (GPT)',
    defaultModel: 'gpt-5.5',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    envVar: 'OPENAI_API_KEY',
    supportsWebSearch: false,
    buildRequest: ({ apiKey, model, system, userText }) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        max_tokens: 400,
      },
    }),
    extractText: (data: unknown) => {
      const d = data as { choices?: Array<{ message?: { content?: string } }> };
      return d?.choices?.[0]?.message?.content || '';
    },
  },
  xai: {
    label: 'Grok (xAI)',
    defaultModel: 'grok-4',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    envVar: 'XAI_API_KEY',
    supportsWebSearch: false,
    buildRequest: ({ apiKey, model, system, userText }) => ({
      url: 'https://api.x.ai/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        max_tokens: 400,
      },
    }),
    extractText: (data: unknown) => {
      const d = data as { choices?: Array<{ message?: { content?: string } }> };
      return d?.choices?.[0]?.message?.content || '';
    },
  },
};

const SYSTEM_WITH_SEARCH =
  'Gold market analyst. Web-search news from last 24-48h affecting XAU/USD (dollar strength, Fed, inflation, yields). ' +
  'Also self-rate how confident you are in this read (1.0 = strong, unambiguous consensus across sources; 0.2 = thin, stale, or conflicting signals). ' +
  'Reply with ONLY raw JSON, no markdown, no preamble: ' +
  '{"sentiment_score":-1to1,"confidence":0to1,"bias":"bullish|bearish|neutral","summary":"<20 words","key_driver":"<6 words"}';

const SYSTEM_NO_SEARCH =
  'Gold market analyst. Based on your general knowledge of typical XAU/USD drivers (dollar strength, Fed policy, inflation, yields), ' +
  'give a plausible current-conditions style estimate. Since this is NOT live search, self-rate confidence low-to-moderate (0.2-0.5) unless the macro backdrop is unusually clear-cut. ' +
  'Reply with ONLY raw JSON, no markdown, no preamble: ' +
  '{"sentiment_score":-1to1,"confidence":0to1,"bias":"bullish|bearish|neutral","summary":"<20 words","key_driver":"<6 words"}';

export async function POST(req: NextRequest) {
  try {
    // ─── Rate Limit Check ───────────────────────────────────────────────
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Retry after ${rateLimit.retryAfter}s.` },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } }
      );
    }

    // ─── Input Validation ─────────────────────────────────────────────────
    const rawBody = await req.json();
    const parseResult = NewsRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { providerKey, model: modelOverride, apiKey: apiKeyOverride } = parseResult.data;
    const provider = PROVIDERS[providerKey];
    if (!provider) {
      return NextResponse.json({ error: `Unknown provider "${providerKey}"` }, { status: 400 });
    }

    const model = modelOverride || provider.defaultModel;
    // Prefer a server-configured key; fall back to one supplied in the request.
    const apiKey = process.env[provider.envVar] || apiKeyOverride;
    if (!apiKey) {
      return NextResponse.json(
        { error: `No API key found. Set ${provider.envVar} in your environment, or pass one from the client.` },
        { status: 401 }
      );
    }

    const system = provider.supportsWebSearch ? SYSTEM_WITH_SEARCH : SYSTEM_NO_SEARCH;
    const req2 = provider.buildRequest({
      apiKey,
      model,
      system,
      userText: 'Gold price drivers right now. JSON only.',
    });

    const upstream = await fetch(req2.url, {
      method: 'POST',
      headers: req2.headers,
      body: JSON.stringify(req2.body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: `${provider.label} request failed (${upstream.status}): ${errText.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const data = await upstream.json();
    const text = provider.extractText(data);
    const clean = text.replace(/```json|```/g, '').trim();
    
    let parsed: any;
    try {
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : clean);
    } catch (e) {
      return NextResponse.json(
        { error: 'Failed to parse JSON response from LLM.', llm_response: clean },
        { status: 500 }
      );
    }

    return NextResponse.json({
      sentiment_score: Math.max(-1, Math.min(1, Number(parsed.sentiment_score) || 0)),
      confidence: Number.isFinite(Number(parsed.confidence))
        ? Math.max(0, Math.min(1, Number(parsed.confidence)))
        : 0.5,
      bias: parsed.bias || 'neutral',
      summary: parsed.summary || '',
      key_driver: parsed.key_driver || '',
      ts: Date.now(),
      providerLabel: provider.label,
      usedWebSearch: provider.supportsWebSearch,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unexpected server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}