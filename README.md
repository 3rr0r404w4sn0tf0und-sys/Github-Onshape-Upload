# Onshape → GitHub Side Panel App

Exports selected parts from an Onshape **Assembly** and uploads them to a
chosen spot in a GitHub repo you pick — with drag-to-replace, archive/delete,
static merging, per-user OAuth on both sides, and your choice of export format.

Created by WanChengJunWang · [source repo](https://github.com/3rr0r404w4sn0tf0und-sys/Github-Onshape-Upload) · licensed under [AGPLv3](./LICENSE)

## Current setup status (as of this build)
- ✅ GitHub OAuth (multi-user, repo picker, default repo, switch repo)
- ✅ Onshape OAuth (multi-user)
- ✅ Assembly-context part listing
- ✅ Drag-and-drop tree with replace/add, per-file trash, per-file/folder rename, new-folder button
- ✅ Staged batch commit, undo/redo (pre-commit only)
- ✅ Inline rename with sibling-dim UX
- ✅ File format picker (STEP / STL / OBJ / Parasolid / IGES / SolidWorks)
- ⚠️ Not yet tested against live GitHub/Onshape APIs — see "known risk areas" below

## Setup

### 1. Register a GitHub OAuth App
GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.
- Homepage URL: your Render URL
- Callback URL: `https://YOUR-RENDER-URL/auth/github/callback`
Save the Client ID + Client Secret.

### 2. Register an Onshape OAuth App
Onshape → account icon → My account → Developer tab → OAuth applications → New.
- Type: **Cloud connected app**
- Redirect URL: `https://YOUR-RENDER-URL/auth/onshape/callback`
- OAuth URL: `https://YOUR-RENDER-URL/`
- Permissions: only check **read profile** + **read documents** (this app never
  writes to or deletes Onshape documents, so leave write/delete unchecked)
Save the Client ID + Client Secret.

### 3. Add the panel as an Extension (not an App Store listing)
On the same OAuth application page → **Extensions** tab → Add extension.
- Location: Element right panel
- Context: **Inside assembly**
- Action URL: `https://YOUR-RENDER-URL/panel.html`

This keeps it private to your account — no App Store submission or
Development Agreement needed.

### 4. Set up Postgres for session storage (Neon)
Sessions (and the GitHub/Onshape tokens they carry) are stored in Postgres,
not in-memory - this is what lets the app survive a redeploy and run more
than one server instance.
- In your Neon dashboard, create a project (or reuse an existing one - this
  app only needs its own database within it, e.g. `onshape_github_sessions`).
- Go to **Connect** on the project and copy the **pooled** connection string
  (the host contains `-pooler`, not the direct one) - this app opens a
  connection per session lookup, which is exactly what the pooled endpoint
  is designed for.
- No manual schema/migration needed - `connect-pg-simple` creates its own
  `session` table automatically on first boot.
- Locally, copy `.env.example` to `.env` and drop the connection string in
  as `DATABASE_URL`. In production, set it as a real environment variable
  (see step 5).

### 5. Deploy on Render
Web Service, `npm install` / `node server.js`, Free tier. Environment variables:

| Variable | Value |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | from step 1 |
| `GITHUB_OAUTH_CLIENT_SECRET` | from step 1 |
| `ONSHAPE_OAUTH_CLIENT_ID` | from step 2 |
| `ONSHAPE_OAUTH_CLIENT_SECRET` | from step 2 |
| `SESSION_SECRET` | Render's "Generate" button |
| `APP_URL` | your Render URL, no trailing slash |
| `DATABASE_URL` | pooled Neon connection string from step 4 |

## Using it
1. Open an **Assembly** tab in Onshape, open the right sidebar, click the app icon.
2. Sign in with GitHub, then with Onshape (both required).
3. Pick a repo — **Use** (this session only) or **Set default** (⭐, remembered).
4. Select parts from the list (pulled from the whole assembly, including
   parts from different Part Studio tabs) → **Stage selected parts**.
5. In the tree: drag a staged card onto an existing file to replace it
   (auto-archived to `Archive/`, or hard-deleted if you toggle that file's
   trash icon into delete-mode), or onto a folder to just add it there.
6. Rename staged files inline (✎) — other staged cards dim while you edit.
7. Set **Static** if some staged parts should merge into one file — note
   they must all come from the *same* Part Studio tab; Onshape can't merge
   geometry across tabs in one export call, and you'll get a clear error if
   you try.
8. Pick your **file format**.
9. Ctrl+Z / Ctrl+Y undo/redo your staging (not anything already committed).
10. **Upload to GitHub** commits the whole batch in one pass.

## Known risk areas — the parts most likely to need a live fix
These have been written against Onshape/GitHub's documented API shapes and
syntax-checked, but not run against the real APIs yet:
- **Onshape OAuth token endpoint** — `server.js` uses `cad.onshape.com/oauth/token`;
  Onshape's own docs have been inconsistent historically about this vs
  `oauth.onshape.com`. First place to check on a 401.
- **Assembly instance field names** (`sourceElementId` etc. in `/api/parts`) —
  best-effort mapping of Onshape's assembly-instances response; likely needs
  a small adjustment once you see the real JSON.
- **File format strings for Parasolid/IGES/SolidWorks** — STEP/STL/OBJ are
  safe bets, the other three may need exact string tweaks.
- **Cookies inside Onshape's iframe** (`SameSite=None; Secure`) — works in
  most browsers, Safari/iOS can be stricter. Symptom: keeps asking you to
  sign in again.

## Other notes
- Sessions live in server memory — a Render restart logs everyone out.
- Static-merge-across-Part-Studios is a real Onshape API limitation, not a
  bug in this app — see step 7 above.
