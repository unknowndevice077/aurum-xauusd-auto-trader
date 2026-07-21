# Aurum — XAU/USD Paper Trading Terminal

This is a Next.js application that provides a paper trading terminal for XAU/USD. It uses technical indicators and optional LLM-based news analysis to simulate trading decisions.

## Project Structure

*   `app/`: Contains the main application pages and API routes.
    *   `api/history/route.ts`: API route to fetch historical price data.
    *   `api/news/route.ts`: API route to fetch news analysis from an LLM.
    *   `globals.css`: Global CSS styles.
    *   `layout.tsx`: The main layout of the application.
    *   `page.tsx`: The main page of the application.
*   `components/`: Contains the React components.
    *   `AurumTerminal.tsx`: The main terminal component.
    *   `PriceChart.tsx`: The price chart component.
*   `lib/`: Contains helper functions and type definitions.
    *   `indicators.ts`: Functions to calculate technical indicators.
    *   `types.ts`: TypeScript type definitions.
*   `next.config.mjs`: Next.js configuration file.
*   `package.json`: Project dependencies and scripts.
*   `tsconfig.json`: TypeScript configuration file.

## 1. Run it locally in VS Code

```bash
# Install dependencies
npm install
```

Create a `.env` file in the root of the project and add the API key for the LLM provider you want to use, e.g.:

```
OPENAI_API_KEY=sk-...
```

Then:

```bash
npm run dev
```

Open http://localhost:3000. In the app, click **LLM settings**, pick "OpenAI (GPT)"
(already the default), leave the "override key" field blank so it uses your `.env`
key, then toggle off **Math-only mode**.


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
