/**
 * Onshape -> GitHub side-panel app backend.
 * See README.md for setup instructions.
 */

const express = require("express");
const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";

// ---------- low-level GitHub helpers ----------

async function getFile(filePath) {
  try {
    const res = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: filePath, ref: BRANCH });
    return res.data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function putFile(filePath, contentBuffer, message, sha) {
  return octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: filePath, message, branch: BRANCH,
    content: contentBuffer.toString("base64"), sha: sha || undefined,
  });
}

async function deleteFile(filePath, message, sha) {
  return octokit.repos.deleteFile({ owner: OWNER, repo: REPO, path: filePath, message, branch: BRANCH, sha });
}

// ---------- repo tree (drives the left pane) ----------

app.get("/api/tree", async (req, res) => {
  try {
    const { data: refData } = await octokit.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
    const { data: commitData } = await octokit.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: refData.object.sha });
    const { data: treeData } = await octokit.git.getTree({ owner: OWNER, repo: REPO, tree_sha: commitData.tree.sha, recursive: "true" });
    const entries = treeData.tree
      .filter((e) => e.type === "blob" || e.type === "tree")
      .map((e) => ({ path: e.path, type: e.type === "tree" ? "folder" : "file", sha: e.sha }));
    res.json({ entries });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch repo tree" });
  }
});

// ---------- Onshape parts for the currently open tab ----------

app.get("/api/parts", async (req, res) => {
  const { documentId, workspaceId, elementId } = req.query;
  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: "missing Onshape context params" });
  }
  try {
    const url = `https://cad.onshape.com/api/v6/parts/d/${documentId}/w/${workspaceId}/e/${elementId}`;
    const { data } = await axios.get(url, {
      auth: { username: process.env.ONSHAPE_ACCESS_KEY, password: process.env.ONSHAPE_SECRET_KEY },
    });
    res.json({ parts: data.map((p) => ({ id: p.partId, name: p.name })) });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch parts from Onshape" });
  }
});

// ---------- Onshape STEP export ----------

async function exportPartsAsStep(documentId, workspaceId, elementId, partIds, merged) {
  const translateUrl = `https://cad.onshape.com/api/v6/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/translations`;
  const auth = { username: process.env.ONSHAPE_ACCESS_KEY, password: process.env.ONSHAPE_SECRET_KEY };

  const { data: job } = await axios.post(translateUrl, {
    formatName: "STEP", partIds: partIds.join(","), onePartPerDoc: !merged, storeInDocument: false,
  }, { auth });

  const statusUrl = `https://cad.onshape.com/api/v6/translations/${job.id}`;
  let result;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await axios.get(statusUrl, { auth });
    if (data.requestState === "DONE") { result = data; break; }
    if (data.requestState === "FAILED") throw new Error("Onshape translation failed: " + JSON.stringify(data));
  }
  if (!result) throw new Error("Onshape translation timed out");

  const fileId = result.resultExternalDataIds[0];
  const downloadUrl = `https://cad.onshape.com/api/v6/externaldata/${fileId}`;
  const { data: fileBuffer } = await axios.get(downloadUrl, { responseType: "arraybuffer", auth });
  return Buffer.from(fileBuffer);
}

// ---------- create an empty folder (git tracks files only, so drop a .gitkeep) ----------

app.post("/api/folder", async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: "folderPath required" });
  try {
    await putFile(`${folderPath}/.gitkeep`, Buffer.from(""), `feat: create folder ${folderPath}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

// ---------- rename a file or folder ----------
// Git has no native rename - it's "create at new path, delete old path".
// For folders, every file under that prefix gets moved the same way.

app.post("/api/rename", async (req, res) => {
  const { oldPath, newPath, isFolder } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: "oldPath and newPath required" });

  try {
    if (isFolder) {
      const { data: refData } = await octokit.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
      const { data: commitData } = await octokit.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: refData.object.sha });
      const { data: treeData } = await octokit.git.getTree({ owner: OWNER, repo: REPO, tree_sha: commitData.tree.sha, recursive: "true" });
      const affected = treeData.tree.filter((e) => e.type === "blob" && e.path.startsWith(oldPath + "/"));

      for (const entry of affected) {
        const file = await getFile(entry.path);
        const relative = entry.path.substring(oldPath.length);
        await putFile(`${newPath}${relative}`, Buffer.from(file.content, "base64"), `chore: move ${entry.path} -> ${newPath}${relative}`);
        await deleteFile(entry.path, `chore: remove old path after folder rename`, file.sha);
      }
    } else {
      const file = await getFile(oldPath);
      if (!file) return res.status(404).json({ error: "File not found" });
      await putFile(newPath, Buffer.from(file.content, "base64"), `chore: rename ${oldPath} -> ${newPath}`);
      await deleteFile(oldPath, `chore: remove old path after rename`, file.sha);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Rename failed" });
  }
});

// ---------- the big one: commit the whole staged batch in one go ----------
// Body shape:
// {
//   documentId, workspaceId, elementId,
//   deletes: ["CAD/Fuselage/old.step", ...],          // per-file trash icon, hard delete
//   items: [
//     {
//       partIds: ["JHD"],           // Onshape part ids to export
//       isStatic: false,
//       name: "Fuselage v7 - Back", // filename (no extension)
//       replaceTarget: "CAD/Fuselage/v6 - Back.step" | null,  // dragged onto existing file
//       destinationPath: "CAD/Fuselage" | null,                // used when replaceTarget is null
//       archiveMode: "archive" | "delete"                      // only relevant when replaceTarget set
//     }, ...
//   ]
// }

app.post("/api/commit", async (req, res) => {
  const { documentId, workspaceId, elementId, deletes = [], items = [] } = req.body;

  try {
    const results = [];

    // Per-file trash-icon deletes on existing tree files (not tied to a replacement)
    for (const targetPath of deletes) {
      const existing = await getFile(targetPath);
      if (existing) {
        await deleteFile(targetPath, `chore: delete ${targetPath}`, existing.sha);
        results.push({ path: targetPath, action: "deleted" });
      }
    }

    // Staged new/replacement files
    for (const item of items) {
      const buffer = await exportPartsAsStep(documentId, workspaceId, elementId, item.partIds, item.isStatic);
      const filename = `${item.name}.step`;
      const targetPath = item.replaceTarget || `${item.destinationPath}/${filename}`;

      const existing = item.replaceTarget ? await getFile(item.replaceTarget) : await getFile(targetPath);

      if (existing) {
        if (item.archiveMode === "delete") {
          await deleteFile(targetPath, `chore: delete ${filename} (replaced)`, existing.sha);
        } else {
          const folder = targetPath.substring(0, targetPath.lastIndexOf("/"));
          const oldFilename = targetPath.substring(targetPath.lastIndexOf("/") + 1);
          await putFile(`${folder}/Archive/${oldFilename}`, Buffer.from(existing.content, "base64"), `chore: archive previous ${oldFilename}`);
          await deleteFile(targetPath, `chore: remove old ${oldFilename} (archived)`, existing.sha);
        }
      }

      await putFile(targetPath, buffer, `feat: upload ${filename} from Onshape`);
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
