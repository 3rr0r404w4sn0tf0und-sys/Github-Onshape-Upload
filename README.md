# Onshape → GitHub Side Panel App (multi-user OAuth, both sides)

## Step 1 — Register a GitHub OAuth App
1. GitHub → Settings → Developer settings → **OAuth Apps** → **New OAuth App**.
2. **Homepage URL**: your Render URL, e.g. `https://onshape-github-panel.onrender.com`
3. **Authorization callback URL**: `https://onshape-github-panel.onrender.com/auth/github/callback`
4. Register, then **Generate a new client secret**. Save both the **Client ID** and **Client Secret**.

## Step 2 — Register an Onshape OAuth App
1. In Onshape: click your account icon (top right) → **My account** → **Developer** tab.
2. **OAuth applications** tab → create a new one.
3. **Redirect URL**: `https://onshape-github-panel.onrender.com/auth/onshape/callback`
4. Select the scopes it can request — you'll want at least read access to
   documents/parts and the ability to create translations (STEP exports).
   Onshape's dev portal lists the available scopes when you set this up;
   pick the narrowest set that covers reading parts + creating translations.
5. Save, copy the **Client ID** and **Client Secret**.

## Step 3 — Push the code
Push this folder to its own repo (e.g. `onshape-github-panel`).

## Step 4 — Deploy on Render
Web Service setup (`npm install` / `node server.js`, Free tier), with these
environment variables:

| Variable | Value |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | from Step 1 |
| `GITHUB_OAUTH_CLIENT_SECRET` | from Step 1 |
| `ONSHAPE_OAUTH_CLIENT_ID` | from Step 2 |
| `ONSHAPE_OAUTH_CLIENT_SECRET` | from Step 2 |
| `SESSION_SECRET` | any long random string (Render has a "Generate" button) |
| `APP_URL` | your Render URL, e.g. `https://onshape-github-panel.onrender.com` — no trailing slash |

No more `ONSHAPE_ACCESS_KEY`/`ONSHAPE_SECRET_KEY`/`GITHUB_TOKEN` — every
credential is now per-user, obtained through sign-in, not baked into the server.

## Step 5 — Register the Onshape App (the panel itself)
This is separate from Step 2 (which was about *authenticating users*) — this
is about *where the panel shows up in Onshape's UI*.
https://dev-portal.onshape.com → Apps → Create app → Location: Element right
panel → App URL: `https://onshape-github-panel.onrender.com/panel.html`

## Step 6 — Test the flow
1. Open the panel in Onshape.
2. Click **Sign in with GitHub** (popup, authorize, closes itself).
3. Click **Sign in with Onshape** (same popup pattern).
4. Once both show ✓, you land on the repo picker — search, then **Use**
   (session-only) or **Set default** (⭐, remembered).
5. Main tool view loads. **Switch repo** at the top re-opens the picker with
   a **← Back** button.

## Known risk areas to watch for when testing live
- **GitHub OAuth token exchange** — historically the most common snag is the
  POST body needing exact URL-encoding and the redirect_uri matching exactly
  what was registered. If `/auth/github/callback` errors, this is the first
  place to check.
- **Onshape OAuth token exchange** — same category of risk; Onshape's docs
  have shown some inconsistency historically between `oauth.onshape.com` and
  `cad.onshape.com` as the token endpoint host. `server.js` currently points
  at `https://cad.onshape.com/oauth/token` — if you get a 401 here, that
  endpoint URL or the scope selection from Step 2 is the first thing to check.
- **Cookies inside Onshape's iframe** — session cookie uses
  `SameSite=None; Secure`, correct for third-party iframe use, but Safari/iOS
  can still block it under strict tracking prevention. Symptom: keeps asking
  you to sign in again. Tell me if you hit this.

## Other things worth knowing
- Sessions live in server memory — a Render restart/redeploy logs everyone
  out. Fine for now; a persistent session store is a small later upgrade.
- **Nothing in this version has been run against the live GitHub or Onshape
  OAuth endpoints yet** — only syntax-checked. Both token exchanges are the
  most likely spots to need a small live fix.

