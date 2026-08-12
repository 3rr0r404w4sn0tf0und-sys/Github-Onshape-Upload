/**
 * Onshape -> GitHub side-panel app backend (multi-user OAuth version).
 * See README.md for setup instructions.
 */

const express = require("express");
const session = require("express-session");
const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1); // Render sits behind a proxy - needed for secure cookies to work

app.get("/", (req, res) => res.redirect("/panel.html"));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: "none",       // required: this app runs inside an Onshape iframe (third-party context)
    maxAge: 1000 * 60 * 60 * 24 * 365, // remember the user + their default repo for a year
  },
}));

const APP_URL = process.env.APP_URL; // e.g. https://onshape-github-panel.onrender.com
const GH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
const GH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;
const OS_CLIENT_ID = process.env.ONSHAPE_OAUTH_CLIENT_ID;
const OS_CLIENT_SECRET = process.env.ONSHAPE_OAUTH_CLIENT_SECRET;

function requireAuth(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not signed in to GitHub" });
  if (!req.session.onshapeAccessToken) return res.status(401).json({ error: "Not signed in to Onshape" });
  next();
}

function octokitFor(req) {
  return new Octokit({ auth: req.session.accessToken });
}

// ---------- GitHub OAuth flow ----------

app.get("/auth/github", (req, res) => {
  const url = `https://github.com/login/oauth/authorize?client_id=${GH_CLIENT_ID}&redirect_uri=${encodeURIComponent(APP_URL + "/auth/github/callback")}&scope=repo`;
  res.redirect(url);
});

app.get("/auth/github/callback", async (req, res) => {
  const { code } = req.query;
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
  const url = `https://oauth.onshape.com/oauth/authorize?response_type=code&client_id=${OS_CLIENT_ID}&redirect_uri=${encodeURIComponent(APP_URL + "/auth/onshape/callback")}`;
  res.redirect(url);
});

app.get("/auth/onshape/callback", async (req, res) => {
  const { code } = req.query;
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
  try {
    const res = await octokitFor(req).repos.getContent({ owner, repo: name, path: filePath });
    return res.data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function putFile(req, filePath, contentBuffer, message, sha) {
  const { owner, name } = activeRepo(req);
  return octokitFor(req).repos.createOrUpdateFileContents({
    owner, repo: name, path: filePath, message,
    content: contentBuffer.toString("base64"), sha: sha || undefined,
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
    const url = `https://cad.onshape.com/api/v6/assemblies/d/${documentId}/${workspaceOrVersion}/${workspaceOrVersionId}/e/${elementId}?includeMateFeatures=false`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${req.session.onshapeAccessToken}` },
    });

    // Per Onshape's documented getAssemblyDefinition response shape, each
    // instance carries: id, partId, name, documentId, elementId, and
    // documentMicroversion - there is NO workspaceId on the instance itself.
    // We pin exports to documentMicroversion rather than guessing a workspace,
    // since that's the exact snapshot the assembly actually references and
    // it's correct even for parts inserted from a different document.
    const parts = (data.rootAssembly?.instances || [])
      .filter((inst) => inst.type === "Part")
      .map((inst) => ({
        id: inst.id,                                   // occurrence id within the assembly
        name: inst.name,
        partId: inst.partId,                            // the underlying part's own id
        sourceDocumentId: inst.documentId,
        sourceElementId: inst.elementId,                 // the Part Studio this part actually lives in
        sourceMicroversion: inst.documentMicroversion,   // exact snapshot to export from
      }));

    res.json({ parts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch assembly parts from Onshape" });
  }
});

// ---------- Onshape STEP export ----------
// Now uses the signed-in user's own Onshape OAuth token, so exports run
// against whatever documents THEY have access to, not a shared dev account.

async function exportPartsAsStep(onshapeToken, sourceDocumentId, sourceMicroversion, sourceElementId, partIds, merged, formatName) {
  const translateUrl = `https://cad.onshape.com/api/v6/partstudios/d/${sourceDocumentId}/m/${sourceMicroversion}/e/${sourceElementId}/translations`;
  const headers = { Authorization: `Bearer ${onshapeToken}` };

  const { data: job } = await axios.post(translateUrl, {
    formatName: formatName || "STEP", partIds: partIds.join(","), onePartPerDoc: !merged, storeInDocument: false,
  }, { headers });

  const statusUrl = `https://cad.onshape.com/api/v6/translations/${job.id}`;
  let result;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await axios.get(statusUrl, { headers });
    if (data.requestState === "DONE") { result = data; break; }
    if (data.requestState === "FAILED") throw new Error("Onshape translation failed: " + JSON.stringify(data));
  }
  if (!result) throw new Error("Onshape translation timed out");

  const fileId = result.resultExternalDataIds[0];
  const downloadUrl = `https://cad.onshape.com/api/v6/externaldata/${fileId}`;
  const { data: fileBuffer } = await axios.get(downloadUrl, { responseType: "arraybuffer", headers });
  return Buffer.from(fileBuffer);
}

// ---------- folder create / rename ----------

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
  const { owner, name } = activeRepo(req);
  const octokit = octokitFor(req);

  try {
    if (isFolder) {
      const { data: repoData } = await octokit.repos.get({ owner, repo: name });
      const branch = repoData.default_branch;
      const { data: refData } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
      const { data: commitData } = await octokit.git.getCommit({ owner, repo: name, commit_sha: refData.object.sha });
      const { data: treeData } = await octokit.git.getTree({ owner, repo: name, tree_sha: commitData.tree.sha, recursive: "true" });
      const affected = treeData.tree.filter((e) => e.type === "blob" && e.path.startsWith(oldPath + "/"));

      for (const entry of affected) {
        const file = await getFile(req, entry.path);
        const relative = entry.path.substring(oldPath.length);
        await putFile(req, `${newPath}${relative}`, Buffer.from(file.content, "base64"), `chore: move ${entry.path} -> ${newPath}${relative}`);
        await deleteFile(req, entry.path, `chore: remove old path after folder rename`, file.sha);
      }
    } else {
      const file = await getFile(req, oldPath);
      if (!file) return res.status(404).json({ error: "File not found" });
      await putFile(req, newPath, Buffer.from(file.content, "base64"), `chore: rename ${oldPath} -> ${newPath}`);
      await deleteFile(req, oldPath, `chore: remove old path after rename`, file.sha);
    }
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

app.post("/api/commit", requireAuth, async (req, res) => {
  if (!activeRepo(req)) return res.status(400).json({ error: "No repo selected" });
  const { deletes = [], items = [] } = req.body;
  // NOTE: no top-level documentId/workspaceId needed anymore - each staged
  // part already carries its own sourceDocumentId/sourceMicroversion/
  // sourceElementId, which is what actually determines where a translation
  // call goes (see /api/parts for why we pin to microversion, not workspace).

  try {
    const results = [];

    for (const targetPath of deletes) {
      const existing = await getFile(req, targetPath);
      if (existing) {
        await deleteFile(req, targetPath, `chore: delete ${targetPath}`, existing.sha);
        results.push({ path: targetPath, action: "deleted" });
      }
    }

    for (const item of items) {
      const formatName = (item.formatName || "STEP").toUpperCase();
      const ext = FORMAT_EXTENSIONS[formatName] || "step";

      if (item.isStatic) {
        // A single translation call can only merge parts that live in the
        // SAME source Part Studio element - group by document+element, not
        // just element id, since two different documents could coincidentally
        // reuse the same element id.
        const distinctSources = new Set(item.parts.map((p) => `${p.sourceDocumentId}:${p.sourceElementId}`));
        if (distinctSources.size > 1) {
          return res.status(400).json({
            error: `"${item.name}" can't be a single static export - its selected parts come from ${distinctSources.size} different Part Studio tabs. Onshape can only merge parts into one file if they're in the same Part Studio. Split this into separate static groups per source tab, or uncheck Static and export them individually.`,
          });
        }
      }

      const filename = `${item.name}.${ext}`;
      const targetPath = item.replaceTarget || `${item.destinationPath}/${filename}`;
      const existing = item.replaceTarget ? await getFile(req, item.replaceTarget) : await getFile(req, targetPath);

      let buffer;
      if (item.isStatic) {
        const { sourceDocumentId, sourceMicroversion, sourceElementId } = item.parts[0];
        buffer = await exportPartsAsStep(req.session.onshapeAccessToken, sourceDocumentId, sourceMicroversion, sourceElementId, item.parts.map((p) => p.partId), true, formatName);
      } else {
        const { sourceDocumentId, sourceMicroversion, sourceElementId, partId } = item.parts[0];
        buffer = await exportPartsAsStep(req.session.onshapeAccessToken, sourceDocumentId, sourceMicroversion, sourceElementId, [partId], false, formatName);
      }

      if (existing) {
        if (item.archiveMode === "delete") {
          await deleteFile(req, targetPath, `chore: delete ${filename} (replaced)`, existing.sha);
        } else {
          const folder = targetPath.substring(0, targetPath.lastIndexOf("/"));
          const oldFilename = targetPath.substring(targetPath.lastIndexOf("/") + 1);
          await putFile(req, `${folder}/Archive/${oldFilename}`, Buffer.from(existing.content, "base64"), `chore: archive previous ${oldFilename}`);
          await deleteFile(req, targetPath, `chore: remove old ${oldFilename} (archived)`, existing.sha);
        }
      }

      await putFile(req, targetPath, buffer, `feat: upload ${filename} from Onshape`);
      results.push({ path: targetPath, action: existing ? (item.archiveMode === "delete" ? "replaced-deleted" : "replaced-archived") : "added" });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Commit failed", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Onshape->GitHub app listening on :${PORT}`));
