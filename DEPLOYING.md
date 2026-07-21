## 2. Deploy to Vercel

**Option A — via GitHub (recommended):**
1. Push this folder to a new GitHub repo.
2. Go to https://vercel.com/new, import the repo.
3. In the Vercel project's **Settings → Environment Variables**, add `OPENAI_API_KEY`
   (and/or `ANTHROPIC_API_KEY`, `XAI_API_KEY`) with the same values from your `.env`.
4. Deploy. Vercel auto-detects Next.js — no config needed.

**Option B — via Vercel CLI, no GitHub needed:**
```bash
npm install -g vercel
vercel login
vercel            # first deploy, follow prompts
vercel env add OPENAI_API_KEY production
vercel --prod
```