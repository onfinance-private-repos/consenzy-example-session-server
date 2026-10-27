# Consenzy example session server

The backend half of the Consenzy mobile example apps. It does the two jobs that need an organisation API key, so the
key stays on a server and never ships inside an app:

| Endpoint | What it does | Consenzy call (live mode) |
|---|---|---|
| `POST /session` `{"external_ref", "acting_as"?}` | Mints a short-lived principal session (`cps_…`) for the signed-in customer and tells the app which base URL to give the SDK | `POST /v1/principal-sessions` |
| `POST /consent-check` `{"external_ref", "purpose_code"}` | Asks the consent ledger whether a purpose is allowed before your backend processes data for it | `POST /v1/consents/check` |
| `GET /demo-customers` | The synthetic customers the example apps offer on their sign-in screen | none |
| `GET /healthz` | Liveness and mode | none |

In **demo mode** (the default) it also serves an in-memory mock of the Consenzy principal API under `/v1/me`, so the
apps work end to end without any Consenzy organisation. Everything in demo mode is synthetic
([`src/fixtures.json`](src/fixtures.json)): a fictional "Demo Bank" notice in English and Hindi with three purposes,
an adult customer `CUST-DEMO-0001` (with one erasure request that "arrived on WhatsApp") and a minor
`CUST-DEMO-CHILD-7` whose consent only a guardian session can give (DPDP Act s.9).

The example apps:

| Platform | Repository |
|---|---|
| Android (Kotlin, Jetpack Compose) | [never2average/consenzy-example-android](https://github.com/never2average/consenzy-example-android) |
| iOS (Swift, SwiftUI) | [never2average/consenzy-example-ios](https://github.com/never2average/consenzy-example-ios) |
| Flutter | [never2average/consenzy-example-flutter](https://github.com/never2average/consenzy-example-flutter) |
| React Native | [never2average/consenzy-example-react-native](https://github.com/never2average/consenzy-example-react-native) |

Each app also has a fully in-app demo mode (no server at all). Point an app at this server to see the real
token flow.

## Run it

Requires Node.js 20.10 or later.

```bash
npm ci
npm start            # demo mode on http://localhost:8787
npm test
```

From an Android emulator the server is `http://10.0.2.2:8787`; from the iOS simulator it is `http://localhost:8787`.
In demo mode `/session` answers with `base_url` set to the host the app called, so the SDK talks to the mock API on
the same server.

```bash
curl -s -X POST localhost:8787/session -H 'content-type: application/json' -d '{"external_ref":"CUST-DEMO-0001"}'
# {"token":"cps_demo_…","principal_id":"…","acting_as":"data_principal","capabilities":[…],"base_url":"http://localhost:8787","mode":"demo"}

curl -s -X POST localhost:8787/consent-check -H 'content-type: application/json' \
  -d '{"external_ref":"CUST-DEMO-0001","purpose_code":"marketing"}'
# {"allowed":false,…} until the customer grants "marketing" in the app
```

## Live mode (a real Consenzy organisation)

1. In the Consenzy portal, register the app under **Configuration → Applications** and issue an API key for this
   backend under **Settings → API Keys** with the `sessions:mint` and `consents:check` scopes.
2. Create principals with the external references you want to test (or set `ALLOWED_EXTERNAL_REFS` to your own).
3. Copy `.env.example` to `.env` (git-ignored) and set:

   ```bash
   CONSENZY_MODE=live
   CONSENZY_BASE_URL=https://consenzy.onfinance.ai     # or your own deployment
   CONSENZY_API_KEY=cdm_…                             # server-side only; never in an app
   ```

4. `node --env-file=.env src/index.js`

The server refuses to start in live mode without both values, and refuses a key that is not an org key (`cdm_…`).
It never returns the key to the app: `/session` returns only the `cps_…` session token.

## Before you copy this into production

- **Authenticate the customer.** This example takes `external_ref` from the request body and checks it against an
  allow-list so it is not an open session-minting service. Your backend must derive the customer from its own login
  instead and never trust the client to say who it is.
- **Guardians (s.9).** Mint `acting_as: "guardian"` only after you have authenticated the parent or lawful guardian,
  and verify the guardian once in Consenzy (`POST /v1/principals/{id}/guardian-verification`).
- Keep the TTL short (this example uses 900 seconds) and serve the endpoint over HTTPS only.

## Licence

The example code is MIT licensed (see [LICENSE](LICENSE)). Consenzy client SDKs are Apache-2.0; the Consenzy server
and API are proprietary OnFinance software and are not part of this repository.
