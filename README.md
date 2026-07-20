# Aurum — XAU/USD Paper Trading Terminal

Next.js app version of the Aurum artifact. Runs locally in VS Code and deploys to Vercel.
The API key never touches the browser — it lives in a server-side env var, and the
frontend calls your own `/api/news` route, which calls OpenAI/Anthropic/xAI on the server.

## 1. Run it locally in VS Code

```bash
# unzip this folder, then open it in VS Code
cd aurum-app
npm install
cp .env.example .env.local
```

Open `.env.local` and set the key for whichever provider you'll use, e.g.:

```
OPENAI_API_KEY=sk-...
```

Then:

```bash
npm run dev
```

Open http://localhost:3000. In the app, click **LLM settings**, pick "OpenAI (GPT)"
(already the default), leave the "override key" field blank so it uses your `.env.local`
key, then toggle off **Math-only mode**.

## 2. Deploy to Vercel

**Option A — via GitHub (recommended):**
1. Push this folder to a new GitHub repo.
2. Go to https://vercel.com/new, import the repo.
3. In the Vercel project's **Settings → Environment Variables**, add `OPENAI_API_KEY`
   (and/or `ANTHROPIC_API_KEY`, `XAI_API_KEY`) with the same values from your `.env.local`.
4. Deploy. Vercel auto-detects Next.js — no config needed.

**Option B — via Vercel CLI, no GitHub needed:**
```bash
npm install -g vercel
vercel login
vercel            # first deploy, follow prompts
vercel env add OPENAI_API_KEY production
vercel --prod
```

## Notes

- **Math-only mode** (SMA20/50 crossover + RSI14) needs no API key at all and costs nothing —
  it's the default until you add a key.
- **News mode** calls your `/api/news` route every ~100s while enabled; that's the only
  place LLM tokens get spent.
- Portfolio state and your provider/model choice persist in the browser via `localStorage`
  (per-browser, not shared across devices).
- Grok's real-time X/Twitter access isn't wired here — this uses xAI's plain chat-completions
  endpoint, so like OpenAI it answers from general knowledge rather than live search. Only the
  Anthropic path has web search enabled (`web_search_20250305`).
- This is a simulated paper-trading tool. No real orders are placed, no brokerage is connected,
  and nothing here is financial advice.
