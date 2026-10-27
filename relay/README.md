# relay — MOA from Taiwan

`data.moa.gov.tw` refuses connections from outside Taiwan. Apps Script runs on
Google's servers abroad, so from 2026-10-22 every crawl timed out (#103). This
is a few dozen lines of Node with no dependencies that run in Taiwan and
forward the backend's queries to the one MOA endpoint:

- **Only** `GET /?CropName=…&Start_time=…&End_time=…` (MOA's own parameters;
  anything else is refused), so it is no open proxy.
- **Only** for a caller sending the key in `X-Relay-Key`.
- MOA's answer and status pass through untouched; a timeout (50 s) or a failed
  connection is a `502`, which the backend reads as "not answered", as it would
  MOA itself.

The rule lives in `handler.mjs` and is tested in `frontend/relay.test.ts`;
`server.mjs` turns a request into its answer whatever fails, and `main.mjs`
(`npm start`) listens.

## Deploy (Cloud Run, Taiwan)

Region `asia-east1` is Changhua, Taiwan, so the relay's requests leave from a
Taiwanese address. Cloud Run needs a project with billing enabled; at this
backend's volume (a crawl every 4 h, ~250 requests each, plus visitors' trend
and search) it stays within the free tier's requests, with egress at most a
few cents a month.

The key lives in Secret Manager, not in the service's environment, where
anyone who can view the service would read it.

```bash
KEY=$(openssl rand -hex 32)   # keep it: it goes into Script Properties too
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com
printf %s "$KEY" | gcloud secrets create moa-relay-key --data-file=-
PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format 'value(projectNumber)')
gcloud secrets add-iam-policy-binding moa-relay-key \
  --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor
gcloud run deploy moa-relay \
  --source relay \
  --region asia-east1 \
  --allow-unauthenticated \
  --set-secrets "RELAY_KEY=moa-relay-key:latest" \
  --max-instances 2 \
  --memory 256Mi
```

`--allow-unauthenticated` lets Apps Script call it without Google sign-in; the
key is what keeps everyone else out. To rotate it, add a new version of the
secret, redeploy, and update `MOA_RELAY_KEY`.

Check it from anywhere — this is the request the backend makes:

```bash
URL=$(gcloud run services describe moa-relay --region asia-east1 --format 'value(status.url)')
curl -H "X-Relay-Key: $KEY" "$URL/?CropName=%E7%94%98%E8%97%8D&Start_time=115.10.24&End_time=115.10.24"
```

`"RS":"OK"` with `Data` means MOA accepts the relay's address. If it hangs or
answers `502 upstream: timeout`, MOA refuses this address too, and the relay
has to run somewhere else in Taiwan (a machine on a Taiwanese ISP behind a
tunnel) — the same code, `npm start` with `RELAY_KEY` and `PORT`.

## Point the backend at it

Apps Script → Project Settings → Script Properties:

| Property | Value |
| --- | --- |
| `MOA_RELAY_URL` | the service URL, e.g. `https://moa-relay-xxxxx-de.a.run.app` |
| `MOA_RELAY_KEY` | the same `$KEY` |

Both, or neither: a URL without a key, or one that is not `https://`, is not
used — `diag.moa_relay` says `"no key, not used"` / `"not https, not used"`.
With both set it shows `true` (never the URL or the key), and the next refresh
should record a new `last_refresh_ok`. A key the relay refuses fails the
refresh as 「MOA 中繼站拒絕連線：MOA_RELAY_KEY 與中繼站的 RELAY_KEY 不符」.
No redeploy is needed: properties take effect on the next execution. Delete
both to go back to MOA directly.
