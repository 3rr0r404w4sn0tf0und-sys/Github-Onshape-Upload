# Onshape → GitHub Side Panel App

## Step 1 — Get your Onshape API keys
1. Go to https://dev-portal.onshape.com and sign in.
2. Click **API Keys** → **Create new API key**.
3. Save the **Access Key** and **Secret Key** somewhere safe — the secret is only shown once.

## Step 2 — Get a GitHub token
1. GitHub → Settings → Developer settings → **Personal access tokens** → **Fine-grained tokens** → Generate new token.
2. **Repository access**: only select `ModuDrone-Labs` (not all repos).
3. **Permissions** → Contents: **Read and write**.
4. Generate, copy the token — you won't see it again.

## Step 3 — Push this app to its own repo
Create a new (separate) GitHub repo, e.g. `onshape-github-panel`, and push this folder's contents to it.
Render deploys from a repo, so this code needs to live somewhere Render can see it.

## Step 4 — Deploy on Render
1. https://render.com → sign up/sign in (GitHub login is easiest).
2. **New** → **Web Service** → connect the `onshape-github-panel` repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Instance type: **Free**.
6. Under **Environment**, add these variables:
   - `ONSHAPE_ACCESS_KEY` = (from Step 1)
   - `ONSHAPE_SECRET_KEY` = (from Step 1)
   - `GITHUB_TOKEN` = (from Step 2)
   - `GITHUB_OWNER` = `3rr0r404w4sn0tf0und-sys`
   - `GITHUB_REPO` = `ModuDrone-Labs`
   - `GITHUB_BRANCH` = `main`
7. Deploy. Render gives you a URL like `https://onshape-github-panel.onrender.com`. Visit `/panel.html` on it once to confirm the page loads (parts/tree will error until Onshape passes real context params — that's expected at this stage).

## Step 5 — Register it as an Onshape App
1. https://dev-portal.onshape.com → **Apps** → **Create app**.
2. Name it whatever you like (e.g. "CAD Sync").
3. **Location**: Element right panel.
4. **App URL**: `https://onshape-github-panel.onrender.com/panel.html`
5. Save. Onshape appends `?documentId=...&workspaceId=...&elementId=...` automatically when it loads your panel — `panel.js` already reads these.
6. You may need to explicitly **install/enable** the app on your own account depending on how Onshape's dev portal handles personal apps — the dev portal UI will guide you through this if so.

## Step 6 — Test it
Open your ModuDrone-Labs document in Onshape, open the right sidebar, click your app's icon. You should see:
- The parts list populate from the currently open tab
- The file tree populate from your repo's actual current structure
- Staging a part, dragging it onto a tree file (should show the little "fly away" cue), and clicking Upload should commit real changes to GitHub

## What each control does
- **Stage selected parts →** — pulls the checked parts from Onshape into the middle staging list.
- **Drag a staged card onto an existing file** — marks it as a *replacement*; on Upload, the old file is archived (moved to `<folder>/Archive/`) unless...
- **✎ pencil on a tree file/folder** — renames it directly in GitHub (immediate, not staged — this happens outside the batch commit).
- **🗑 trash on a tree file** — marks it for hard deletion on the next Upload (toggle again to un-mark; shown with a red tint while marked).
- **＋ folder button above the tree** — creates a new folder (via a hidden `.gitkeep` placeholder, since git doesn't track empty folders).
- **Static checkbox** — merges every staged part into a single STEP file instead of one file per part.
- **↶ / ↷** — undo/redo your staging actions (adds, removals, renames-within-stage, replacement assignments). This does **not** undo anything already committed to GitHub — renames and folder creation happen immediately against the real repo, only the final "Upload" batch is staged/undoable beforehand.
- **Upload to GitHub** — commits every staged item and pending delete in one pass.

## Known limitations to be aware of
- **Free Render tier sleeps after ~15 min idle** — first click after a while away takes 10-20s to wake up. Not a bug.
- **No live drag-shake animation yet** — the current drop gives a quick "fly away" fade/scale cue on the replaced tree row; a true cursor-follow shake effect would need a bit more CSS/JS polish once you're testing against the real thing.
- **Renames/folder creation happen immediately**, not as part of the staged batch — worth confirming that matches what you want, since it means those two actions can't be undone via Ctrl+Z once clicked (they're already real commits).
- This has **not been run against the live Onshape/GitHub APIs yet** — only syntax-checked. The Onshape translation endpoint's exact response shape is the most likely thing to need a small tweak once you test for real.
