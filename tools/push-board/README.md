# push-board — refresh the board from a machine in Taiwan

`data.moa.gov.tw` refuses connections from outside Taiwan, and Apps Script runs
on Google's servers abroad, so the scheduled refresh cannot reach it (#103).
This tool runs the crawl on your own machine, which MOA does answer, and hands
the rows to the backend. Nothing to host and nothing to pay for: it runs when
you run it.

- **The crawl is the backend's own.** `backend.mjs` loads `backend/*.gs` with
  the Apps Script services shimmed, and runs its `crawlDays` under its own
  `withCrawlBudget`: the trading-date probe, the board's roots, the batches
  (each one concurrent, as `UrlFetchApp.fetchAll`'s) and the retry are the
  ones a scheduled refresh uses. The budget is the tool's own, 10 minutes
  rather than the backend's 3 — no Apps Script limit to fit in here — and a
  crawl it cuts short fails with the backend's own reason. A root MOA silences
  even on retry is left out as a refresh would leave it, and listed, since you
  can re-run. Nothing is re-implemented here.
- **The backend does the rest.** `POST ?action=push&token=…` (operator only)
  takes the rows instead of asking MOA and runs a normal refresh on them: the
  board is built, put through the plausibility guard, stored, written to the
  history and the Sheet archive, and the mirror deploy is requested. A crawl
  the guard rejects is not stored, and the tool prints why.
- **A malformed body changes nothing.** The backend takes only a crawl: real
  ROC dates in order and not in the future, and rows a card can be built
  from. Anything else is refused whole; rows MOA would never have answered
  for that crawl (another root, another day) are dropped, and the guard judges
  the rest — an older trading date than the board on air included.

## Once: deploy the backend with `doPost`

The `/exec` URL serves a pinned deployment; `clasp push` alone does not change
it. From `backend/`:

```bash
clasp push
clasp deploy -i <deploymentId>   # the ID in VITE_API_BASE_URL, frontend/.env
```

Until then the tool says "The Web App does not take a push yet".

## Each time

Node 22 or later. No `npm install`: the tool has no dependencies. Behind an
HTTP proxy, set `NODE_USE_ENV_PROXY=1` as well (Node 22.21+ / 24): Node's
`fetch` uses `HTTPS_PROXY` only then.

```bash
cd tools/push-board
node push.mjs --dry-run      # crawl only: the trading dates and how many roots answered on each
```

Then push, with the `ADMIN_TOKEN` script property as the token:

```bash
# macOS / Linux
ADMIN_TOKEN='…' node push.mjs
```

```powershell
# Windows PowerShell
$env:ADMIN_TOKEN='…'; node push.mjs
```

A crawl takes a few minutes. On success it prints
`Stored: N items for 115.10.27, generated …`, and `?action=diag` shows the
refresh in `last_refresh_ok`.

| Flag | |
| --- | --- |
| `--dry-run` | Crawl and report; push nothing. No token needed |
| `--verbose` | Log every request that failed, and the crawl's own log |
| `--api=<url>` | Push to another Web App (default: `API_BASE_URL`, else `VITE_API_BASE_URL` in `frontend/.env`) |

## What the messages mean

| Message | |
| --- | --- |
| `近期查無交易資料` / `向 MOA 抓取資料逾時…` then `MOA did not answer the crawl` | This machine cannot reach MOA either: not in Taiwan, MOA is down, or (behind a proxy) `NODE_USE_ENV_PROXY=1` is not set |
| `unanswered on 115.10.27: …` | MOA did not answer those crops even on retry; they are left out, as a scheduled refresh would. Re-run to try again |
| `Refused: ADMIN_TOKEN does not match` | The token is not the `ADMIN_TOKEN` script property |
| `The Web App does not take a push yet` | The deployment predates `doPost`: see above |
| `No answer from the backend` | The request gave up before the refresh did; the tool then reads `?action=diag` and says whether the day was stored. Check it before pushing again |
| `Another push is still being stored` | A push made moments ago is still running its refresh; one push at a time, so the board is never written twice at once |
| `Not stored: …` | The plausibility guard rejected the board, with its reasons — the same verdict a scheduled refresh would get |

## The static mirror

The backend requests the GitHub Pages redeploy itself when the
`GH_DISPATCH_TOKEN` script property is set. Without it, run the
**Deploy to GitHub Pages** workflow by hand after a push, or wait for its
schedule.

The tool's code path is tested end to end in `frontend/backendCode.test.ts`
(`a crawl pushed from Taiwan`): the tool crawls a fake MOA, and the backend
stores the board from the push without asking MOA itself.
