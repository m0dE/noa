# Noa extension

## Google sign-in (Log In)

**Log in with Google** (the side panel's account menu) uses `chrome.identity.launchWebAuthFlow` with a Google
OAuth **Web application** client. The client ID is baked in at build time:

```sh
# either
NOA_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com pnpm --filter @noa/extension build
# or put it in apps/extension/config.json (gitignored; see config.example.json)
{ "googleClientId": "1234567890-abc.apps.googleusercontent.com" }
```

Without it, Log In asks the account server for its client ID (`GET /v1/config`,
the API's first `GOOGLE_CLIENT_ID`), and says so plainly when the server has
none. Either way the client needs the
redirect URI `https://<extension id>.chromiumapp.org/` (the ID is in
`extension-id.txt`), and the account server must accept the same client ID
(`GOOGLE_CLIENT_ID`, see `apps/api/README.md`).

The account server defaults to `https://app.noa.bot`. An install
saved with an earlier default (`PREVIOUS_ACCOUNT_API_BASES` in
`packages/shared/src/settings.ts`) moves to it by itself, signed in session
included, when the service worker starts (install, update, browser start).
Self-hosters can change it in Settings > Advanced > Account server.
The runner-key cloud sync stays there as well, for servers without accounts.

Plans, top-ups and invoices are on the dashboard's Billing page
(`<account server origin>/billing`); every plan or top-up button in the
extension opens it in a new tab (`src/ui/billing.ts`, URLs from
`src/account/dashboard.ts`).
