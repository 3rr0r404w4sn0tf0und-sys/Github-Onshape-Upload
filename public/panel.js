const params = new URLSearchParams(window.location.search);
const ctx = {
  documentId: params.get("documentId"),
  workspaceId: params.get("workspaceId"),
  elementId: params.get("elementId"),
};

const loginView = document.getElementById("loginView");
const repoPickerView = document.getElementById("repoPickerView");
const mainView = document.getElementById("mainView");
const githubLoginBtn = document.getElementById("githubLoginBtn");
const onshapeLoginBtn = document.getElementById("onshapeLoginBtn");
const onshapeStatus = document.getElementById("onshapeStatus");
const repoSearch = document.getElementById("repoSearch");
const repoList = document.getElementById("repoList");

let me = null;
let allRepos = [];

async function checkAuth() {
  const res = await fetch("/api/me");
  me = await res.json();
  if (!me.githubLoggedIn || !me.onshapeLoggedIn) {
    show("login");
    updateLoginButtons();
    return;
  }
  if (!me.defaultRepo) {
    await openRepoPicker(false);
  } else {
    activeRepoInfo = me.defaultRepo;
    show("main");
    initMainView();
  }
}

function updateLoginButtons() {
  githubLoginBtn.style.display = me?.githubLoggedIn ? "none" : "block";
  onshapeLoginBtn.style.display = me?.onshapeLoggedIn ? "none" : "block";
  githubLoginBtn.textContent = me?.githubLoggedIn ? "✓ GitHub connected" : "Sign in with GitHub";
  onshapeStatus.textContent = me?.onshapeLoggedIn ? "✓ Onshape connected" : "";
}

function show(view) {
  loginView.style.display = view === "login" ? "flex" : "none";
  repoPickerView.style.display = view === "repo" ? "block" : "none";
  mainView.style.display = view === "main" ? "block" : "none";
}

function openAuthPopup(url, expectedMessage) {
  const popup = window.open(url, "auth", "width=600,height=700");
  window.addEventListener("message", function handler(e) {
    if (e.data === expectedMessage) {
      window.removeEventListener("message", handler);
      checkAuth();
    }
  });
}

githubLoginBtn.addEventListener("click", () => openAuthPopup("/auth/github", "github-auth-success"));
onshapeLoginBtn.addEventListener("click", () => openAuthPopup("/auth/onshape", "onshape-auth-success"));

let activeRepoInfo = null;
let cameFromMainView = false;

async function openRepoPicker(fromMain) {
  cameFromMainView = fromMain;
  show("repo");
  const topBar = repoPickerView.querySelector("#topBar") || document.querySelectorAll("#topBar")[0];
  if (fromMain) {
    document.querySelectorAll("#topBar")[0].style.display = "flex";
    document.querySelectorAll("#topBar")[0].innerHTML = `<button id="backBtn">← Back</button><span></span>`;
    document.getElementById("backBtn").addEventListener("click", () => { show("main"); });
  }
  repoList.innerHTML = "Loading…";
  const res = await fetch("/api/repos");
  const data = await res.json();
  allRepos = data.repos || [];
  renderRepoList(allRepos);
}

function renderRepoList(repos) {
  repoList.innerHTML = repos.map((r) => `
    <div class="repo-row">
      <span>${r.fullName}${me.defaultRepo && me.defaultRepo.fullName === r.fullName ? " ⭐" : ""}</span>
      <span style="display:flex; gap:6px;">
        <button class="secondary" data-action="use" data-owner="${r.owner}" data-name="${r.name}">Use</button>
        <button data-action="default" data-owner="${r.owner}" data-name="${r.name}">Set default</button>
      </span>
    </div>
  `).join("");

  repoList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const owner = btn.dataset.owner, name = btn.dataset.name;
      if (btn.dataset.action === "default") {
        const res = await fetch("/api/set-default-repo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, name }) });
        const data = await res.json();
        me.defaultRepo = data.defaultRepo;
        activeRepoInfo = data.defaultRepo;
      } else {
        const res = await fetch("/api/use-repo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, name }) });
        const data = await res.json();
        activeRepoInfo = data.activeRepo;
      }
      show("main");
      initMainView();
    });
  });
}

repoSearch.addEventListener("input", () => {
  const q = repoSearch.value.toLowerCase();
  renderRepoList(allRepos.filter((r) => r.fullName.toLowerCase().includes(q)));
});

function setupTopBar() {
  const bar = document.querySelectorAll("#topBar")[1]; // the one inside mainView
  bar.innerHTML = `
    <span>${activeRepoInfo ? activeRepoInfo.fullName : ""} — signed in as ${me.username}</span>
    <button id="switchRepoBtn">Switch repo</button>
  `;
  document.getElementById("switchRepoBtn").addEventListener("click", () => openRepoPicker(true));
}

// ---------------- main tool logic (only runs once a repo is active) ----------------

let mainViewInitialized = false;
function initMainView() {
  setupTopBar();
  if (mainViewInitialized) return; // avoid double-binding listeners on repeat switches
  mainViewInitialized = true;
  initTool();
}

function initTool() {
const partSelect = document.getElementById("partSelect");
const stageBtn = document.getElementById("stageBtn");
const treePane = document.getElementById("treePane");
const stagePane = document.getElementById("stagePane");
const staticCheck = document.getElementById("staticCheck");
const formatSelect = document.getElementById("formatSelect");
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("status");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");

// ---------- state ----------
// staged items the user built up before hitting Upload
let staged = [];         // [{ id, partId, partName, name, replaceTarget, archiveMode }]
let pendingDeletes = []; // [path] - trash-icon deletes on existing tree files
let treeEntries = [];    // raw entries from /api/tree

let history = [];  // undo/redo stack of {staged, pendingDeletes} snapshots
let historyIndex = -1;

function snapshot() {
  history = history.slice(0, historyIndex + 1);
  history.push({ staged: JSON.parse(JSON.stringify(staged)), pendingDeletes: [...pendingDeletes] });
  historyIndex++;
}
function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restore(history[historyIndex]);
}
function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restore(history[historyIndex]);
}
function restore(snap) {
  staged = JSON.parse(JSON.stringify(snap.staged));
  pendingDeletes = [...snap.pendingDeletes];
  renderStage();
  renderTree();
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
});
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

// ---------- load parts + tree ----------

let partsById = {}; // occurrence id -> full part info (name, partId, sourceElementId)

async function loadParts() {
  const res = await fetch(`/api/parts?${params.toString()}`);
  const { parts } = await res.json();
  partsById = {};
  parts.forEach((p) => { partsById[p.id] = p; });
  partSelect.innerHTML = parts.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
}

async function loadTree() {
  const res = await fetch("/api/tree");
  const { entries } = await res.json();
  treeEntries = entries;
  renderTree();
}

stageBtn.addEventListener("click", () => {
  const selected = Array.from(partSelect.selectedOptions);
  if (!selected.length) return;
  for (const opt of selected) {
    const info = partsById[opt.value];
    staged.push({
      id: crypto.randomUUID(),
      occurrenceId: opt.value,
      partId: info.partId,
      sourceElementId: info.sourceElementId, // which Part Studio tab this part actually lives in
      partName: opt.textContent,
      name: opt.textContent,       // editable filename, defaults to part name
      replaceTarget: null,
      archiveMode: "archive",
    });
  }
  snapshot();
  renderStage();
});

// ---------- tree rendering (nested by path) ----------

function buildNestedTree(entries) {
  const root = {};
  for (const e of entries) {
    if (e.path.endsWith("/.gitkeep")) continue; // hide placeholder files
    const parts = e.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      if (!node[part]) node[part] = { __children: {}, __isFile: isLast && e.type === "file", __path: parts.slice(0, i + 1).join("/") };
      node = node[part].__children;
    });
  }
  return root;
}

function renderTree() {
  const nested = buildNestedTree(treeEntries);
  treePane.innerHTML = `
    <div class="tree-header">
      <span style="opacity:0.5; font-size:10px;">repo root</span>
      <span class="icon-btn" id="newFolderBtn" title="New folder">＋</span>
    </div>
    <div id="treeRoot"></div>
  `;
  document.getElementById("treeRoot").appendChild(renderNode(nested, 0));
  document.getElementById("newFolderBtn").addEventListener("click", () => createFolder(""));
}

function renderNode(node, depth) {
  const wrap = document.createElement("div");
  for (const key of Object.keys(node).sort()) {
    const entry = node[key];
    const isFile = entry.__isFile;
    const row = document.createElement("div");
    row.className = "tree-node";
    row.innerHTML = `<div class="tree-line"></div>`;

    const inner = document.createElement("div");
    inner.className = "row" + (isFile ? "" : " folder");
    inner.dataset.path = entry.__path;
    inner.innerHTML = `
      <span class="row-label">${isFile ? "📄" : "📁"} ${key}</span>
      <span class="row-actions">
        <span class="rename-icon" title="Rename">✎</span>
        ${isFile ? '<span class="delete-icon" title="Delete">🗑</span>' : ""}
      </span>
    `;

    inner.querySelector(".rename-icon").addEventListener("click", (e) => {
      e.stopPropagation();
      renamePath(entry.__path, isFile);
    });
    const delIcon = inner.querySelector(".delete-icon");
    if (delIcon) {
      delIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDelete(entry.__path, inner);
      });
    }

    if (isFile) {
      inner.addEventListener("dragover", (e) => { e.preventDefault(); inner.classList.add("dragover"); });
      inner.addEventListener("dragleave", () => inner.classList.remove("dragover"));
      inner.addEventListener("drop", (e) => {
        e.preventDefault();
        inner.classList.remove("dragover");
        const stagedId = e.dataTransfer.getData("text/plain");
        assignReplacement(stagedId, entry.__path, inner);
      });
    } else {
      // dropping onto a folder = add as new file there, no replacement
      inner.addEventListener("dragover", (e) => { e.preventDefault(); inner.classList.add("dragover"); });
      inner.addEventListener("dragleave", () => inner.classList.remove("dragover"));
      inner.addEventListener("drop", (e) => {
        e.preventDefault();
        inner.classList.remove("dragover");
        const stagedId = e.dataTransfer.getData("text/plain");
        assignDestination(stagedId, entry.__path);
      });
    }

    row.appendChild(inner);
    if (Object.keys(entry.__children).length) {
      const childWrap = document.createElement("div");
      childWrap.style.marginLeft = "10px";
      childWrap.appendChild(renderNode(entry.__children, depth + 1));
      row.appendChild(childWrap);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function toggleDelete(path, rowEl) {
  const idx = pendingDeletes.indexOf(path);
  if (idx === -1) {
    pendingDeletes.push(path);
    rowEl.style.background = "#5c1e1e";
  } else {
    pendingDeletes.splice(idx, 1);
    rowEl.style.background = "";
  }
  snapshot();
}

async function createFolder(parentPath) {
  const name = prompt("New folder name:");
  if (!name) return;
  const folderPath = parentPath ? `${parentPath}/${name}` : name;
  await fetch("/api/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderPath }) });
  await loadTree();
}

async function renamePath(oldPath, isFile) {
  const currentName = oldPath.split("/").pop();
  const newName = prompt("Rename to:", currentName);
  if (!newName || newName === currentName) return;
  const parent = oldPath.substring(0, oldPath.lastIndexOf("/"));
  const newPath = parent ? `${parent}/${newName}` : newName;
  await fetch("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldPath, newPath, isFolder: !isFile }) });
  await loadTree();
}

// ---------- staging pane ----------

let editingId = null; // which staged card is currently in inline-rename mode

function renderStage() {
  if (!staged.length) {
    stagePane.innerHTML = `<div style="opacity:0.5; font-size:11px;">Stage parts above</div>`;
    return;
  }
  stagePane.innerHTML = "";
  for (const item of staged) {
    const card = document.createElement("div");
    card.className = "stage-card" + (editingId && editingId !== item.id ? " dimmed" : "");
    card.draggable = editingId === null; // don't allow dragging mid-rename
    card.dataset.id = item.id;

    if (editingId === item.id) {
      card.innerHTML = `<input type="text" class="rename-input" value="${item.name}" />`;
      const input = card.querySelector("input");
      const commit = () => {
        if (input.value.trim()) item.name = input.value.trim();
        editingId = null;
        snapshot();
        renderStage();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { editingId = null; renderStage(); } });
      input.addEventListener("blur", commit);
      // defer focus so it happens after the input is actually in the DOM
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      card.innerHTML = `
        <span class="row-label">📄 ${item.name}${item.replaceTarget ? ` → replaces ${item.replaceTarget.split("/").pop()}` : ""}</span>
        <span class="row-actions">
          <span class="rename-icon" title="Rename">✎</span>
          <span class="unstage-icon" title="Remove" style="color:#e5534b;">✕</span>
        </span>
      `;
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", item.id);
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));

      card.querySelector(".rename-icon").addEventListener("click", () => {
        editingId = item.id; // dims every other card until this one is committed
        renderStage();
      });
      card.querySelector(".unstage-icon").addEventListener("click", () => {
        staged = staged.filter((s) => s.id !== item.id);
        snapshot();
        renderStage();
      });
    }

    stagePane.appendChild(card);
  }
}

function assignReplacement(stagedId, targetPath, rowEl) {
  const item = staged.find((s) => s.id === stagedId);
  if (!item) return;
  item.replaceTarget = targetPath;
  item.destinationPath = null;
  // little "flies off" cue on the tree row to signal it'll be archived on commit
  rowEl.classList.add("flying-away");
  setTimeout(() => rowEl.classList.remove("flying-away"), 350);
  snapshot();
  renderStage();
}

function assignDestination(stagedId, folderPath) {
  const item = staged.find((s) => s.id === stagedId);
  if (!item) return;
  item.replaceTarget = null;
  item.destinationPath = folderPath;
  snapshot();
  renderStage();
}

// unstaging by deselecting in the part list too
partSelect.addEventListener("change", () => {
  const selectedIds = new Set(Array.from(partSelect.selectedOptions).map((o) => o.value));
  staged = staged.filter((s) => selectedIds.has(s.partId) || s.__manuallyKept);
});

// ---------- commit ----------

uploadBtn.addEventListener("click", async () => {
  if (!staged.length && !pendingDeletes.length) {
    setStatus("Nothing staged.");
    return;
  }
  for (const item of staged) {
    if (!item.replaceTarget && !item.destinationPath) {
      setStatus(`"${item.name}" needs a destination — drag it onto a folder or file in the tree.`);
      return;
    }
  }

  uploadBtn.disabled = true;
  setStatus("Uploading…");

  const formatName = formatSelect.value;

  const items = staticCheck.checked
    ? [{
        parts: staged.map((s) => ({ sourceElementId: s.sourceElementId, partId: s.partId })),
        isStatic: true,
        name: staged[0]?.name || "Static Export",
        replaceTarget: staged.find((s) => s.replaceTarget)?.replaceTarget || null,
        destinationPath: staged.find((s) => s.destinationPath)?.destinationPath || null,
        archiveMode: staged[0]?.archiveMode || "archive",
        formatName,
      }]
    : staged.map((s) => ({
        parts: [{ sourceElementId: s.sourceElementId, partId: s.partId }],
        isStatic: false,
        name: s.name,
        replaceTarget: s.replaceTarget,
        destinationPath: s.destinationPath,
        archiveMode: s.archiveMode,
        formatName,
      }));

  try {
    const res = await fetch("/api/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: ctx.documentId, workspaceId: ctx.workspaceId, deletes: pendingDeletes, items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Commit failed");
    setStatus("Done:\n" + data.results.map((r) => `${r.path} — ${r.action}`).join("\n"));
    staged = [];
    pendingDeletes = [];
    history = []; historyIndex = -1;
    renderStage();
    await loadTree();
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    uploadBtn.disabled = false;
  }
});

function setStatus(msg) { statusEl.textContent = msg; }

loadParts();
loadTree();
snapshot();
}

checkAuth();
