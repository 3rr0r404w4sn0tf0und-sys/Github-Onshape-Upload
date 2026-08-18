/**
 * Onshape -> GitHub side-panel app backend (multi-user OAuth version).
 * See README.md for setup instructions.
 *
 * Copyright (C) 2026  WanChengJunWang
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for the full text.
 */

// Loads .env for local dev only - in production (Render, etc.) real env vars
// are already set, and dotenv silently no-ops if there's no .env file.
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1); // Render sits behind a proxy - needed for secure cookies to work

app.get("/", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect("/panel.html" + qs);
});

// Session store: Postgres (e.g. Neon) instead of the default in-memory store.
// MemoryStore leaks memory over time and doesn't survive a restart/redeploy
// or work across more than one server instance - fine for local dev, not for
// production with real concurrent users. connect-pg-simple auto-creates its
// "session" table on first run (createTableIfMissing).
//
// max: 10 keeps this well under Neon's free-tier pooled-connection ceiling
// even if Render spins up a couple of instances; idleTimeoutMillis lets idle
// connections close instead of sitting open against a serverless endpoint
// that autosuspends on inactivity anyway.
if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set - falling back to in-memory sessions (NOT suitable for production).");
}
const pgPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon requires SSL; its cert chain isn't in Node's default trust store
      max: 10,
      idleTimeoutMillis: 30000,
    })
  : null;

if (pgPool) {
  pgPool.on("error", (err) => {
    // Fires for connections sitting idle in the pool that get dropped server-side
    // (e.g. Neon autosuspend/reconnect) - log it, don't crash the whole process.
    console.error("Unexpected Postgres pool error:", err.message);
  });
}

app.use(session({
  store: pgPool ? new pgSession({ pool: pgPool, createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: "none",       // required: this app runs inside an Onshape iframe (third-party context)
    maxAge: 1000 * 60 * 60 * 24 * 365, // remember the user + their default repo for a year
  },
}));

// ---------- rate limiting ----------
// Basic ceilings so a runaway script (or scraper) can't hammer the OAuth
// flow or rack up GitHub/Onshape API + DB load on your behalf. Limits are
// generous for genuine interactive use and only bite under sustained
// automated traffic - loosen these if real usage ever legitimately bumps
// into them.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please wait a few minutes and try again." },
});
const commitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by session (not just IP) where available, so one heavy user
  // doesn't get lumped in with everyone else behind the same NAT/office IP.
  keyGenerator: (req) => req.session?.id || req.ip,
  message: { error: "Too many commits in a short window. Please slow down a bit." },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.id || req.ip,
  message: { error: "Too many requests. Please slow down a bit." },
});

app.use(["/auth/github", "/auth/onshape"], authLimiter);
app.use("/api/commit", commitLimiter);
app.use("/api", apiLimiter);

const APP_URL = process.env.APP_URL; // e.g. https://onshape-github-panel.onrender.com
const GH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
const GH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;
const OS_CLIENT_ID = process.env.ONSHAPE_OAUTH_CLIENT_ID;
const OS_CLIENT_SECRET = process.env.ONSHAPE_OAUTH_CLIENT_SECRET;

// Rejects any repo path containing a ".." segment or a leading "/" before
// it's ever handed to GitHub's API. Nothing in the current UI generates a
// path like that, but every path here originates from the client (JSON the
// browser sent), and the browser is never trustworthy input for a web app -
// this is a backstop against a malformed/tampered request or a future bug
// upstream that builds a bad path, not a response to any specific incident.
function isSafeRepoPath(p) {
  if (typeof p !== "string" || !p.length) return false;
  if (p.startsWith("/")) return false;
  return !p.split("/").some((seg) => seg === ".." || seg === ".");
}

function requireAuth(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not signed in to GitHub" });
  if (!req.session.onshapeAccessToken) return res.status(401).json({ error: "Not signed in to Onshape" });
  next();
}

function octokitFor(req) {
  return new Octokit({ auth: req.session.accessToken });
}

// ---------- Onshape access token refresh ----------
// Onshape access tokens expire (roughly an hour) - without this, any panel
// session that runs longer than that hits a raw 401 "invalid_token" on
// whatever Onshape call happens to fire next, which is confusing since
// nothing about what the user did was wrong. This transparently uses the
// stored refresh_token to mint a new access token and retries the call once.
async function refreshOnshapeToken(req) {
  if (!req.session.onshapeRefreshToken) {
    delete req.session.onshapeAccessToken;
    const err = new Error("Your Onshape session expired - please sign in to Onshape again.");
    err.isKnownLimitation = true;
    throw err;
  }
  try {
    const tokenRes = await axios.post(
      "https://oauth.onshape.com/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: req.session.onshapeRefreshToken,
        client_id: OS_CLIENT_ID,
        client_secret: OS_CLIENT_SECRET,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    req.session.onshapeAccessToken = tokenRes.data.access_token;
    // Onshape may or may not rotate the refresh token on each use - keep the
    // new one if it sent one back, otherwise the existing one stays valid.
    if (tokenRes.data.refresh_token) req.session.onshapeRefreshToken = tokenRes.data.refresh_token;
    return req.session.onshapeAccessToken;
  } catch (err) {
    console.error("Onshape token refresh failed:", err.response?.data || err.message);
    delete req.session.onshapeAccessToken;
    delete req.session.onshapeRefreshToken;
    const wrapped = new Error("Your Onshape session expired - please sign in to Onshape again.");
    wrapped.isKnownLimitation = true;
    throw wrapped;
  }
}

// Wraps a single Onshape API call: on a 401 (expired/invalid access token),
// silently refreshes via refreshOnshapeToken and retries exactly once.
// requestFn receives the current access token and returns the axios promise.
async function onshapeRequest(req, requestFn) {
  try {
    return await requestFn(req.session.onshapeAccessToken);
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    await refreshOnshapeToken(req);
    return await requestFn(req.session.onshapeAccessToken);
  }
}

// ---------- GitHub OAuth flow ----------

app.get("/auth/github", (req, res) => {
  // CSRF guard: a random, single-use value tied to THIS session, checked
  // against whatever the callback comes back with. Without it, an attacker
  // could craft their own /auth/github/callback?code=... link using a code
  // from an OAuth flow they control and get a victim's browser to complete
  // it in the victim's session (session fixation) - the state round-trip is
  // what proves the callback actually belongs to a flow this app started.
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.githubOauthState = state;
  const url = `https://github.com/login/oauth/authorize?client_id=${GH_CLIENT_ID}&redirect_uri=${encodeURIComponent(APP_URL + "/auth/github/callback")}&scope=repo&state=${state}`;
  res.redirect(url);
});

app.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.session.githubOauthState;
  delete req.session.githubOauthState; // single-use
  if (!state || !expectedState || state !== expectedState) {
    return res.status(400).send("GitHub OAuth failed: invalid or missing state parameter (possible CSRF attempt). Please try signing in again.");
  }
  try {
    const tokenRes = await axios.post(
      "https://github.com/login/oauth/access_token",
      { client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code },
      { headers: { Accept: "application/json" } }
    );
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) throw new Error("No access token returned: " + JSON.stringify(tokenRes.data));

    const { data: user } = await axios.get("https://api.github.com/user", {
      headers: { Authorization: `token ${accessToken}` },
    });

    req.session.accessToken = accessToken;
    req.session.username = user.login;
    req.session.avatarUrl = user.avatar_url;

    res.send(`<script>window.opener.postMessage("github-auth-success", "*"); window.close();</script>`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("GitHub OAuth failed: " + (err.response?.data?.error_description || err.message));
  }
});

// ---------- Onshape OAuth flow ----------
// Same popup pattern as GitHub, for consistency and to sidestep any question
// about whether Onshape's own authorize page allows being framed.

app.get("/auth/onshape", (req, res) => {
  // Same CSRF guard as the GitHub flow - see comment there for why.
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.onshapeOauthState = state;
  const url = `https://oauth.onshape.com/oauth/authorize?response_type=code&client_id=${OS_CLIENT_ID}&redirect_uri=${encodeURIComponent(APP_URL + "/auth/onshape/callback")}&state=${state}`;
  res.redirect(url);
});

app.get("/auth/onshape/callback", async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.session.onshapeOauthState;
  delete req.session.onshapeOauthState; // single-use
  if (!state || !expectedState || state !== expectedState) {
    return res.status(400).send("Onshape OAuth failed: invalid or missing state parameter (possible CSRF attempt). Please try signing in again.");
  }
  try {
    const tokenRes = await axios.post(
      "https://oauth.onshape.com/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: OS_CLIENT_ID,
        client_secret: OS_CLIENT_SECRET,
        redirect_uri: APP_URL + "/auth/onshape/callback",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    req.session.onshapeAccessToken = tokenRes.data.access_token;
    req.session.onshapeRefreshToken = tokenRes.data.refresh_token;

    res.send(`<script>window.opener.postMessage("onshape-auth-success", "*"); window.close();</script>`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Onshape OAuth failed: " + (err.response?.data?.error_description || err.message));
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.post("/api/logout-github", (req, res) => {
  // Clears GitHub auth + repo selection only - Onshape session stays intact,
  // so switching GitHub accounts doesn't force re-authorizing Onshape too.
  delete req.session.accessToken;
  delete req.session.username;
  delete req.session.avatarUrl;
  delete req.session.defaultRepo;
  delete req.session.activeRepo;
  res.json({ success: true });
});

app.get("/api/me", (req, res) => {
  res.json({
    githubLoggedIn: !!req.session.accessToken,
    onshapeLoggedIn: !!req.session.onshapeAccessToken,
    username: req.session.username,
    avatarUrl: req.session.avatarUrl,
    defaultRepo: req.session.defaultRepo || null,
  });
});

// ---------- repo picker ----------

app.get("/api/repos", requireAuth, async (req, res) => {
  try {
    const octokit = octokitFor(req);
    const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, { per_page: 100, sort: "updated" });
    res.json({ repos: repos.map((r) => ({ owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private })) });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to list repos" });
  }
});

app.post("/api/set-default-repo", requireAuth, (req, res) => {
  const { owner, name } = req.body;
  if (!owner || !name) return res.status(400).json({ error: "owner and name required" });
  req.session.defaultRepo = { owner, name, fullName: `${owner}/${name}` };
  req.session.activeRepo = req.session.defaultRepo; // also switch to it immediately
  res.json({ success: true, defaultRepo: req.session.defaultRepo });
});

app.post("/api/use-repo", requireAuth, (req, res) => {
  // Switch which repo the current session is writing to, WITHOUT changing the saved default.
  const { owner, name } = req.body;
  if (!owner || !name) return res.status(400).json({ error: "owner and name required" });
  req.session.activeRepo = { owner, name, fullName: `${owner}/${name}` };
  res.json({ success: true, activeRepo: req.session.activeRepo });
});

function activeRepo(req) {
  return req.session.activeRepo || req.session.defaultRepo;
}

// ---------- low-level GitHub helpers (now per-request, per-user) ----------

async function getFile(req, filePath) {
  const { owner, name } = activeRepo(req);
  const octokit = octokitFor(req);
  try {
    const res = await octokit.repos.getContent({ owner, repo: name, path: filePath });
    if (Array.isArray(res.data)) return null; // path is a directory, not a file
    if (!res.data.content && res.data.sha) {
      // GitHub's Contents API doesn't reliably return inline content for
      // files over ~1MB (content comes back empty, no error) - common for
      // CAD exports (STEP/Parasolid) once they have any real complexity.
      // Fall back to the git blobs API, which supports up to 100MB, so
      // archiving/replacing a large file doesn't silently write an empty
      // file where the old content should be.
      const blob = await octokit.git.getBlob({ owner, repo: name, file_sha: res.data.sha });
      return { ...res.data, content: blob.data.content, encoding: blob.data.encoding };
    }
    return res.data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function putFile(req, filePath, contentBuffer, message, sha) {
  const { owner, name } = activeRepo(req);
  // GitHub's create-or-update endpoint requires the CURRENT sha to overwrite
  // a file that already exists - omit it and it 422s with "sha wasn't
  // supplied" the moment the target path already has content. Look it up
  // automatically unless the caller already has it in hand (cheaper when
  // they do, e.g. the archive/replace flow that already fetched `existing`).
  let resolvedSha = sha;
  if (!resolvedSha) {
    const existing = await getFile(req, filePath);
    if (existing) resolvedSha = existing.sha;
  }
  return octokitFor(req).repos.createOrUpdateFileContents({
    owner, repo: name, path: filePath, message,
    content: contentBuffer.toString("base64"), sha: resolvedSha || undefined,
  });
}

async function deleteFile(req, filePath, message, sha) {
  const { owner, name } = activeRepo(req);
  return octokitFor(req).repos.deleteFile({ owner, repo: name, path: filePath, message, sha });
}

// ---------- repo tree ----------

app.get("/api/tree", requireAuth, async (req, res) => {
  if (!activeRepo(req)) return res.status(400).json({ error: "No repo selected yet" });
  const { owner, name } = activeRepo(req);
  try {
    const octokit = octokitFor(req);
    const { data: repoData } = await octokit.repos.get({ owner, repo: name });
    const branch = repoData.default_branch;
    const { data: refData } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
    const { data: commitData } = await octokit.git.getCommit({ owner, repo: name, commit_sha: refData.object.sha });
    const { data: treeData } = await octokit.git.getTree({ owner, repo: name, tree_sha: commitData.tree.sha, recursive: "true" });
    const entries = treeData.tree
      .filter((e) => e.type === "blob" || e.type === "tree")
      .map((e) => ({ path: e.path, type: e.type === "tree" ? "folder" : "file", sha: e.sha }));
    res.json({ entries, branch });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch repo tree" });
  }
});

// ---------- Onshape parts for the currently open tab ----------

app.get("/api/parts", requireAuth, async (req, res) => {
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId } = req.query;
  if (!documentId || !workspaceOrVersion || !workspaceOrVersionId || !elementId) {
    return res.status(400).json({ error: "missing Onshape context params" });
  }
  try {
    // workspaceOrVersion is "w" or "v" depending on whether you're viewing a
    // live workspace or a frozen version - Onshape's generic element path
    // pattern is /d/{did}/{w|v}/{wvid}/e/{eid}, so we build it dynamically
    // rather than assuming "w".
    //
    // This app is a Part Studio tool (not an assembly tool): every part
    // listed here, and every export, comes from THIS Part Studio tab.
    // That's a deliberate simplification, not an oversight - see the big
    // comment above exportPartsAsStep for why: Onshape's public API has no
    // way to selectively export a specific part from an assembly (the
    // assembly translation endpoint ignores any part filter and always
    // exports everything), so trying to be an "assembly tool" meant either
    // silently over-exporting or hitting parts that live directly in the
    // assembly with no Part Studio to export from at all. Scoping to a
    // single Part Studio sidesteps all of that.
    const url = `https://cad.onshape.com/api/v6/parts/d/${documentId}/${workspaceOrVersion}/${workspaceOrVersionId}/e/${elementId}`;
    const { data } = await onshapeRequest(req, (token) =>
      axios.get(url, { headers: { Authorization: `Bearer ${token}` } })
    );

    const parts = (data || []).map((p) => ({
      id: p.partId,
      name: p.name,
      partId: p.partId,
    }));

    res.json({ parts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    if (err.isKnownLimitation) return res.status(401).json({ error: err.message });
    res.status(500).json({ error: "Failed to fetch parts from this Part Studio" });
  }
});

// ---------- Onshape STEP export ----------
// Now uses the signed-in user's own Onshape OAuth token, so exports run
// against whatever documents THEY have access to, not a shared dev account.

// IMPORTANT: Onshape's assembly translation endpoint (/assemblies/.../translations)
// does NOT support filtering by part - confirmed against Onshape's own forum: the
// "partIds" field is a Part Studio translation feature only, and passing it to the
// assembly endpoint is silently ignored, always exporting the ENTIRE assembly. That
// was the actual cause of "I selected one part and it exported the whole drone" - an
// earlier version of this file used that endpoint on the (wrong) assumption it would
// respect a selection AND preserve mated positions. It does neither.
//
// The only endpoint that actually supports selecting specific parts is the Part
// Studio translation endpoint. Since this app now only ever works against a
// single, currently-open Part Studio (see /api/parts), every export just uses
// that same live workspace/version context directly - no more per-part
// document/microversion pinning, and no more "different Part Studio" merge
// restriction, since everything staged always comes from the one open tab.
async function exportPartsAsStep(req, documentId, workspaceOrVersion, workspaceOrVersionId, elementId, partIds, merged, formatName) {
  const translateUrl = `https://cad.onshape.com/api/v6/partstudios/d/${documentId}/${workspaceOrVersion}/${workspaceOrVersionId}/e/${elementId}/translations`;
  const normalizedFormat = (formatName || "STEP").toUpperCase();

  try {
    const body = {
      formatName: normalizedFormat, partIds: partIds.join(","), onePartPerDoc: !merged, storeInDocument: false,
    };
    if (FORMATS_REQUIRING_RESOLUTION.has(normalizedFormat)) {
      body.resolution = "fine"; // required by Onshape for mesh formats, otherwise translation fails with "Invalid resolution parameters were specified"
    }
    const { data: job } = await onshapeRequest(req, (token) =>
      axios.post(translateUrl, body, { headers: { Authorization: `Bearer ${token}` } })
    );

    return await downloadOnshapeTranslation(req, documentId, job.id);
  } catch (err) {
    if (err.response?.status === 404) {
      const notFoundErr = new Error(
        "Onshape couldn't find this Part Studio to export from - the panel may be stale. Try closing and reopening it from the Part Studio tab."
      );
      notFoundErr.isKnownLimitation = true;
      throw notFoundErr;
    }
    throw err;
  }
}


async function downloadOnshapeTranslation(req, documentId, jobId) {
  const statusUrl = `https://cad.onshape.com/api/v6/translations/${jobId}`;
  let result;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await onshapeRequest(req, (token) =>
      axios.get(statusUrl, { headers: { Authorization: `Bearer ${token}` } })
    );
    if (data.requestState === "DONE") { result = data; break; }
    if (data.requestState === "FAILED") throw new Error("Onshape translation failed: " + JSON.stringify(data));
  }
  if (!result) throw new Error("Onshape translation timed out");

  // The download endpoint is scoped under the owning document
  // (/documents/d/{documentId}/externaldata/{fid}), NOT a bare /externaldata/{fid}.
  const fileId = result.resultExternalDataIds[0];
  const downloadUrl = `https://cad.onshape.com/api/v6/documents/d/${documentId}/externaldata/${fileId}`;
  const { data: fileBuffer } = await onshapeRequest(req, (token) =>
    axios.get(downloadUrl, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${token}` } })
  );
  return Buffer.from(fileBuffer);
}

// ---------- folder create / rename ----------
//
// These low-level helpers are shared by the standalone /api/folder + /api/rename
// endpoints (kept for compatibility) AND by /api/commit, which is what the panel
// actually calls now - folder creates/deletes/renames are queued client-side and
// only touch GitHub once, in the same batched commit as everything else, instead
// of firing immediately when the user clicks "new folder"/"rename".

async function getRepoTree(req) {
  const { owner, name } = activeRepo(req);
  const octokit = octokitFor(req);
  const { data: repoData } = await octokit.repos.get({ owner, repo: name });
  const branch = repoData.default_branch;
  const { data: refData } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
  const { data: commitData } = await octokit.git.getCommit({ owner, repo: name, commit_sha: refData.object.sha });
  const { data: treeData } = await octokit.git.getTree({ owner, repo: name, tree_sha: commitData.tree.sha, recursive: "true" });
  return treeData.tree;
}

// msgFn optionally transforms each default commit message (applies custom
// prefix/description from the panel's settings, if the caller supplied
// one) - defaults to identity so callers that don't care are unaffected.
async function applyRename(req, oldPath, newPath, isFolder, msgFn = (m) => m) {
  if (isFolder) {
    const tree = await getRepoTree(req);
    const affected = tree.filter((e) => e.type === "blob" && (e.path === oldPath || e.path.startsWith(oldPath + "/")));
    for (const entry of affected) {
      const file = await getFile(req, entry.path);
      if (!file) continue;
      const relative = entry.path.substring(oldPath.length); // e.g. "/Sub/file.step", or "" if this IS the renamed path itself
      const newFullPath = newPath ? `${newPath}${relative}` : relative.replace(/^\//, "");
      await putFile(req, newFullPath, Buffer.from(file.content, "base64"), msgFn(`chore: move ${entry.path} -> ${newFullPath}`));
      await deleteFile(req, entry.path, msgFn(`chore: remove old path after folder move`), file.sha);
    }
  } else {
    const file = await getFile(req, oldPath);
    if (!file) return;
    await putFile(req, newPath, Buffer.from(file.content, "base64"), msgFn(`chore: rename ${oldPath} -> ${newPath}`));
    await deleteFile(req, oldPath, msgFn(`chore: remove old path after rename`), file.sha);
  }
}

async function applyFolderDelete(req, folderPath, msgFn = (m) => m) {
  const tree = await getRepoTree(req);
  const affected = tree.filter((e) => e.type === "blob" && (e.path === folderPath || e.path.startsWith(folderPath + "/")));
  for (const entry of affected) {
    await deleteFile(req, entry.path, msgFn(`chore: delete folder ${folderPath}`), entry.sha);
  }
}

// Looks for an existing "archive" folder (any casing) directly inside parentFolder,
// so replaced files land next to whatever archive folder the user already has
// (e.g. "Fuselage/Archive") instead of always creating a fresh "Archive" folder.
async function findArchiveFolderName(req, parentFolder) {
  const { owner, name } = activeRepo(req);
  const octokit = octokitFor(req);
  try {
    const { data } = await octokit.repos.getContent({ owner, repo: name, path: parentFolder || "" });
    if (Array.isArray(data)) {
      const found = data.find((e) => e.type === "dir" && e.name.toLowerCase() === "archive");
      if (found) return found.name;
    }
  } catch (err) {
    // parentFolder may not exist yet (e.g. brand-new destination) - fall back below
  }
  return "Archive";
}

app.post("/api/folder", requireAuth, async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: "folderPath required" });
  try {
    await putFile(req, `${folderPath}/.gitkeep`, Buffer.from(""), `feat: create folder ${folderPath}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

app.post("/api/rename", requireAuth, async (req, res) => {
  const { oldPath, newPath, isFolder } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: "oldPath and newPath required" });
  try {
    await applyRename(req, oldPath, newPath, isFolder);
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Rename failed" });
  }
});

// ---------- batched commit ----------

const FORMAT_EXTENSIONS = {
  STEP: "step", STL: "stl", OBJ: "obj", PARASOLID: "x_t", IGES: "igs", SOLIDWORKS: "sldprt",
};

// Mesh-based formats reject the translation request with "Invalid resolution
// parameters were specified" unless a `resolution` is included - STEP/IGES/
// Parasolid/SolidWorks (exact-geometry formats) don't take this param at all.
// See: https://forum.onshape.com/discussion/25465
const FORMATS_REQUIRING_RESOLUTION = new Set(["STL", "OBJ", "GLTF", "GLB", "3MF", "URDF"]);

app.post("/api/commit", requireAuth, async (req, res) => {
  if (!activeRepo(req)) return res.status(400).json({ error: "No repo selected" });
  const { deletes = [], items = [], renames = [], folderDeletes = [], folderCreates = [] } = req.body;
  // Every part staged in this app comes from the SAME currently-open Part
  // Studio - `context` (documentId/workspaceOrVersion/workspaceOrVersionId/
  // elementId) is that Part Studio, sent by the panel alongside the items.
  const { context = null } = req.body;

  // Optional per-commit customization from the panel's settings pane:
  // - commitPrefix swaps the leading "feat:"/"chore:" on every
  //   auto-generated summary line (deletes, archives, folder creates, the
  //   upload message, etc.) for something else, e.g. "onshape-sync:".
  // - commitMessageTemplate fully replaces the summary line for staged
  //   items specifically (the "feat: upload X from Onshape" one), with a
  //   {filename} placeholder. Falls back to the default when blank.
  // - commitDescription is an extended body appended under the summary
  //   line on EVERY commit this batch makes (GitHub shows summary bold,
  //   description below it) - e.g. a standing note like "Synced from
  //   Onshape Part Studio via panel app." Supports {filename}.
  const { commitPrefix = "", commitMessageTemplate = "", commitDescription = "" } = req.body;
  const trimmedPrefix = typeof commitPrefix === "string" ? commitPrefix.trim() : "";
  const trimmedTemplate = typeof commitMessageTemplate === "string" ? commitMessageTemplate.trim() : "";
  const trimmedDescription = typeof commitDescription === "string" ? commitDescription.trim() : "";
  // Applies the custom prefix (if any) to a default "feat: ..."/"chore: ..."
  // message by swapping just the leading word before the colon - leaves the
  // rest of the message (which describes what actually happened) untouched.
  function withPrefix(defaultMessage) {
    if (!trimmedPrefix) return defaultMessage;
    const colonIdx = defaultMessage.indexOf(":");
    return colonIdx === -1 ? defaultMessage : `${trimmedPrefix}${defaultMessage.slice(colonIdx)}`;
  }
  // Appends the extended description (if any) below the summary line, git's
  // usual convention: summary, blank line, then the body. {filename} is
  // substituted in if the caller passed one along.
  function withDescription(summaryLine, filename) {
    if (!trimmedDescription) return summaryLine;
    const body = filename ? trimmedDescription.replace(/\{filename\}/g, filename) : trimmedDescription;
    return `${summaryLine}\n\n${body}`;
  }
  function commitMessage(defaultSummary, filename) {
    const summary = withPrefix(defaultSummary);
    return withDescription(summary, filename);
  }
  function uploadMessage(filename) {
    const summary = trimmedTemplate ? trimmedTemplate.replace(/\{filename\}/g, filename) : withPrefix(`feat: upload ${filename} from Onshape`);
    return withDescription(summary, filename);
  }

  try {
    if (items.length && (!context || !context.documentId)) {
      return res.status(400).json({ error: "Missing Part Studio context - try reopening the panel from its tab." });
    }

    // Validate every path in the batch BEFORE any writes happen, so a bad
    // path fails the whole request cleanly instead of partway through.
    const allPaths = [
      ...deletes,
      ...folderDeletes,
      ...folderCreates,
      ...renames.flatMap((r) => [r.oldPath, r.newPath]),
      ...items.flatMap((it) => [it.destinationPath, it.replaceTarget, ...(it.replaceTargets || [])].filter(Boolean)),
    ];
    const badPath = allPaths.find((p) => !isSafeRepoPath(p));
    if (badPath !== undefined) {
      return res.status(400).json({ error: `Invalid path: "${badPath}"` });
    }

    const results = [];

    // Turns any thrown error into a readable {reason} string instead of a
    // raw axios/error object - used by every per-item catch block below so
    // one bad step reports clearly instead of dumping a stack trace shape.
    function describeError(err) {
      if (err.isKnownLimitation) return err.message;
      const failedUrl = err.config ? `${(err.config.method || "?").toUpperCase()} ${err.config.url}` : null;
      let upstreamBody = null;
      if (err.response?.data) {
        // axios can hand back the error body as a raw Buffer (e.g. when the
        // request was made with responseType: "arraybuffer", as our file
        // download calls are) - decode it to text instead of dumping a
        // byte-array wall of numbers into the error message.
        const raw = Buffer.isBuffer(err.response.data) ? err.response.data.toString("utf8") : JSON.stringify(err.response.data);
        upstreamBody = raw.slice(0, 300);
      }
      console.error(failedUrl, err.response?.status, upstreamBody || err.message);
      return failedUrl
        ? `${failedUrl} → ${err.response?.status}${upstreamBody ? " " + upstreamBody : ""}`
        : err.message;
    }

    // Every step below is wrapped individually instead of letting one
    // failure throw out of the whole handler. That way a batch of, say, 10
    // staged items where #4 fails still commits 1-3 and 5-10, and the
    // response tells you exactly which ones landed vs. which didn't -
    // instead of an all-or-nothing 500 that leaves you guessing what
    // actually happened to your repo. Each pushed result carries
    // `ok: true/false` plus `error` on failure.

    // Renames/moves and folder deletes queued while the user was working in
    // the tree get applied first, so everything downstream (deletes, archive
    // lookups, replace targets) sees the tree in its final shape.
    for (const r of renames) {
      const path = `${r.oldPath} → ${r.newPath}`;
      try {
        await applyRename(req, r.oldPath, r.newPath, r.isFolder, commitMessage);
        results.push({ path, action: r.isFolder ? "folder moved" : "renamed", ok: true });
      } catch (err) {
        results.push({ path, action: r.isFolder ? "folder moved" : "renamed", ok: false, error: describeError(err) });
      }
    }

    for (const folderPath of folderDeletes) {
      try {
        await applyFolderDelete(req, folderPath, commitMessage);
        results.push({ path: folderPath, action: "folder deleted", ok: true });
      } catch (err) {
        results.push({ path: folderPath, action: "folder deleted", ok: false, error: describeError(err) });
      }
    }

    for (const targetPath of deletes) {
      try {
        const existing = await getFile(req, targetPath);
        if (existing) {
          await deleteFile(req, targetPath, commitMessage(`chore: delete ${targetPath}`), existing.sha);
          results.push({ path: targetPath, action: "deleted", ok: true });
        }
      } catch (err) {
        results.push({ path: targetPath, action: "deleted", ok: false, error: describeError(err) });
      }
    }

    // Empty new folders need a placeholder to exist in git at all - but skip
    // creating one if a file is being uploaded straight into that folder in
    // this same commit, since the file itself is enough to establish it (that's
    // also what avoids leaving a stray blank .gitkeep sitting next to real files).
    const destinationsThisCommit = new Set(items.map((it) => it.destinationPath).filter(Boolean));
    for (const folderPath of folderCreates) {
      if (destinationsThisCommit.has(folderPath)) continue;
      try {
        await putFile(req, `${folderPath}/.gitkeep`, Buffer.from(""), commitMessage(`feat: create folder ${folderPath}`));
        results.push({ path: folderPath, action: "folder created", ok: true });
      } catch (err) {
        results.push({ path: folderPath, action: "folder created", ok: false, error: describeError(err) });
      }
    }

    for (const item of items) {
      const formatName = (item.formatName || "STEP").toUpperCase();
      const ext = FORMAT_EXTENSIONS[formatName] || "step";

      const filename = `${item.name}.${ext}`;
      // A static merge can be standing in for MULTIPLE previously-separate
      // files (one staged part per old file) - replaceTargets carries all of
      // them; replaceTarget (singular) is kept as a fallback for the
      // non-static per-part path, which only ever has one.
      const replaceTargets = (item.replaceTargets && item.replaceTargets.length)
        ? item.replaceTargets
        : (item.replaceTarget ? [item.replaceTarget] : []);
      const primaryReplaceTarget = replaceTargets[0] || null;

      // When replacing, only the FOLDER should carry over from the old file -
      // the actual filename has to come from item.name/ext (what the user
      // picked this time), otherwise the rename and format choice both get
      // silently discarded and the old file just gets overwritten in place
      // under its old name/extension with the newly-exported content.
      const replaceFolder = primaryReplaceTarget && primaryReplaceTarget.includes("/")
        ? primaryReplaceTarget.substring(0, primaryReplaceTarget.lastIndexOf("/"))
        : "";
      const targetPath = primaryReplaceTarget
        ? (replaceFolder ? `${replaceFolder}/${filename}` : filename)
        : (item.destinationPath ? `${item.destinationPath}/${filename}` : filename);

      try {
        const buffer = await exportPartsAsStep(
          req,
          context.documentId,
          context.workspaceOrVersion,
          context.workspaceOrVersionId,
          context.elementId,
          item.parts.map((p) => p.partId),
          item.isStatic && item.parts.length > 1,
          formatName,
        );

        // Write the NEW file first, before touching any old file this is
        // replacing. If this item fails anywhere above this line, nothing
        // about the old file has been touched yet - it's still safely
        // sitting in the repo, so a failed export/write never costs you
        // the file it was supposed to replace. Old-file cleanup only runs
        // once the new file is confirmed written.
        await putFile(req, targetPath, buffer, uploadMessage(filename));

        // Archive/delete every OLD file this export is replacing, each at its
        // own original path/name - never targetPath, which by this point is
        // the NEW (possibly renamed) path. A static merge with several staged
        // parts, each with their own replaceTarget, needs ALL of them cleaned
        // up here, not just the first. Each old file's cleanup is its own
        // try/catch so one failing (e.g. already gone) doesn't stop the
        // others, and doesn't retroactively "fail" the new file that's
        // already safely committed above.
        let anyReplaced = false;
        const cleanupErrors = [];
        for (const oldPath of replaceTargets) {
          try {
            const existing = await getFile(req, oldPath);
            if (!existing) continue;
            anyReplaced = true;
            const oldFilename = oldPath.includes("/") ? oldPath.substring(oldPath.lastIndexOf("/") + 1) : oldPath;
            if (item.archiveMode === "delete") {
              await deleteFile(req, oldPath, commitMessage(`chore: delete ${oldFilename} (replaced)`), existing.sha);
            } else {
              const folder = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
              // Look for whatever "archive" folder already exists in this folder
              // (any casing) rather than always assuming one named exactly "Archive".
              const archiveFolderName = await findArchiveFolderName(req, folder);
              const archivePath = folder ? `${folder}/${archiveFolderName}/${oldFilename}` : `${archiveFolderName}/${oldFilename}`;
              await putFile(req, archivePath, Buffer.from(existing.content, "base64"), commitMessage(`chore: archive previous ${oldFilename}`));
              await deleteFile(req, oldPath, commitMessage(`chore: remove old ${oldFilename} (archived)`), existing.sha);
            }
          } catch (err) {
            cleanupErrors.push(`${oldPath}: ${describeError(err)}`);
          }
        }

        const action = anyReplaced ? (item.archiveMode === "delete" ? "replaced-deleted" : "replaced-archived") : "added";
        if (cleanupErrors.length) {
          // New file is up either way - flag this as a partial success so
          // it's visible that some old file(s) weren't cleaned up, rather
          // than silently reporting full success.
          results.push({ path: targetPath, action, ok: true, warning: `New file uploaded, but cleanup of old file(s) failed: ${cleanupErrors.join("; ")}` });
        } else {
          results.push({ path: targetPath, action, ok: true });
        }
      } catch (err) {
        results.push({ path: targetPath, action: "add/replace", ok: false, error: describeError(err) });
      }
    }

    const failures = results.filter((r) => !r.ok);
    res.json({
      success: failures.length === 0,
      partial: failures.length > 0 && failures.length < results.length,
      results,
    });
  } catch (err) {
    // Only truly unexpected/setup-level errors (bad request body, missing
    // context, etc.) still reach here - per-step failures are caught above
    // and reported in `results` instead of aborting the whole commit.
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Commit failed", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Onshape->GitHub app listening on :${PORT}`));
