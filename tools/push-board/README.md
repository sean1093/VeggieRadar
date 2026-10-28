# push-board — refresh the board from a machine in Taiwan

`data.moa.gov.tw` refuses connections from outside Taiwan, and Apps Script runs
on Google's servers abroad, so the scheduled refresh cannot reach it (#103).
This tool runs the crawl on your own machine, which MOA does answer, and hands
the rows to the backend. Nothing to host and nothing to pay for: it runs when
you run it.

- **The crawl is the backend's own.** `backend.mjs` loads `backend/*.gs` with
  the Apps Script services shimmed (requests go out through `curl`), so the
  trading-date probe, the board's roots, the batching, retries and the crawl
  budget are the ones a scheduled refresh uses. Nothing is re-implemented here.
- **The backend does the rest.** `POST ?action=push&token=…` (operator only)
  takes the rows instead of asking MOA and runs a normal refresh on them: the
  board is built, put through the plausibility guard, stored, written to the
  history and the Sheet archive, and the mirror deploy is requested. A crawl
  the guard rejects is not stored, and the tool prints why.
- **A malformed body changes nothing.** The backend accepts only a crawl —
  ROC dates in order and not in the future, the board's own roots, each row's
  plain values — and refuses anything else whole.

## Once: deploy the backend with `doPost`

The `/exec` URL serves a pinned deployment; `clasp push` alone does not change
it. From `backend/`:

```bash
clasp push
clasp deploy -i <deploymentId>   # the ID in VITE_API_BASE_URL, frontend/.env
```

Until then the tool says "The Web App does not take a push yet".

## Each time

Node 22 or later, and `curl` (macOS, Linux and Windows 10+ ship it). No
`npm install`: the tool has no dependencies.

```bash
cd tools/push-board
node push.mjs --dry-run      # crawl only: the trading date and how many roots answered
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
| `No trading date found: MOA did not answer` | This machine cannot reach MOA either: not in Taiwan, or MOA is down |
| `Refused: ADMIN_TOKEN does not match` | The token is not the `ADMIN_TOKEN` script property |
| `The Web App does not take a push yet` | The deployment predates `doPost`: see above |
| `Not stored: …` | The plausibility guard rejected the board, with its reasons — the same verdict a scheduled refresh would get |

## The static mirror

The backend requests the GitHub Pages redeploy itself when the
`GH_DISPATCH_TOKEN` script property is set. Without it, run the
**Deploy to GitHub Pages** workflow by hand after a push, or wait for its
schedule.

The tool's code path is tested end to end in `frontend/backendCode.test.ts`
(`a crawl pushed from Taiwan`): the tool crawls a fake MOA, and the backend
stores the board from the push without asking MOA itself.
