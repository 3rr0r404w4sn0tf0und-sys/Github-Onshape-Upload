const params = new URLSearchParams(window.location.search);
const ctx = {
  documentId: params.get("documentId"),
  workspaceOrVersion: params.get("workspaceOrVersion"), // "w" or "v"
  workspaceOrVersionId: params.get("workspaceOrVersionId"),
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

// ---------- custom scrollbar behavior: thin + auto-hides + reduced wheel sensitivity ----------
function attachCustomScroll(el) {
  if (!el || el.__customScrollAttached) return;
  el.__customScrollAttached = true;
  el.classList.add("scroll-thin");
  let hideTimer;
  el.addEventListener("scroll", () => {
    el.classList.add("scrolling");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove("scrolling"), 600);
  });
  el.addEventListener("wheel", (e) => {
    // lower scroll sensitivity - dampen the delta instead of the browser default jump
    e.preventDefault();
    el.scrollTop += e.deltaY * 0.45;
  }, { passive: false });
}

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
  attachCustomScroll(repoList);
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
      <span>${r.fullName}${me.defaultRepo && me.defaultRepo.fullName === r.fullName ? " ⭐" : ""}${activeRepoInfo && activeRepoInfo.fullName === r.fullName ? " (active)" : ""}</span>
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
    <span style="display:flex; gap:10px;">
      <button id="switchRepoBtn">Switch repo</button>
      <button id="signOutBtn">Sign out</button>
    </span>
  `;
  document.getElementById("switchRepoBtn").addEventListener("click", () => openRepoPicker(true));
  document.getElementById("signOutBtn").addEventListener("click", async () => {
    await fetch("/api/logout-github", { method: "POST" });
    me = null;
    activeRepoInfo = null;
    mainViewInitialized = false; // allow re-binding tool listeners on next sign-in
    checkAuth();
  });
}

// ---------------- main tool logic (only runs once a repo is active) ----------------

let mainViewInitialized = false;
let refreshRepoData = null; // set by initTool(); re-run whenever the active repo changes

function initMainView() {
  setupTopBar();
  if (mainViewInitialized) {
    // We've already bound the tool's listeners once - but the ACTIVE REPO has just
    // changed (Switch repo / Set default), so the tree + staged state must be
    // reloaded against the new repo instead of silently showing stale data from
    // whichever repo happened to load first.
    if (refreshRepoData) refreshRepoData();
    return;
  }
  mainViewInitialized = true;
  initTool();
}

function initTool() {
const partSelect = document.getElementById("partSelect");
const stageBtn = document.getElementById("stageBtn");
const treePane = document.getElementById("treePane");
const stagePane = document.getElementById("stagePane");
const staticCheck = document.getElementById("staticCheck");
const deleteInsteadCheck = document.getElementById("deleteInsteadCheck");
const formatSelect = document.getElementById("formatSelect");
let partsById = {}; // partId -> part info (name, partId) from the current Part Studio
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("status");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");

attachCustomScroll(treePane);
attachCustomScroll(stagePane);

// ---------- state ----------
// staged items the user built up before hitting Upload
let staged = [];              // [{ id, partId, partName, name, replaceTarget, destinationPath, archiveMode }]
let pendingDeletes = [];      // [realPath] - trash-icon deletes on existing tree FILES
let pendingFolderDeletes = [];// [realPath] - trash-icon deletes on existing tree FOLDERS (recursive)
let pendingFolderCreates = [];// [displayPath] - new, not-yet-created folders
let pendingRenames = {};      // realPath -> { newPath, isFolder } - renames/moves, applied at commit time
let treeEntries = [];         // raw entries from /api/tree

let history = [];  // undo/redo stack of state snapshots
let historyIndex = -1;

function snapshot() {
  history = history.slice(0, historyIndex + 1);
  history.push({
    staged: JSON.parse(JSON.stringify(staged)),
    pendingDeletes: [...pendingDeletes],
    pendingFolderDeletes: [...pendingFolderDeletes],
    pendingFolderCreates: [...pendingFolderCreates],
    pendingRenames: JSON.parse(JSON.stringify(pendingRenames)),
  });
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
  pendingFolderDeletes = [...snap.pendingFolderDeletes];
  pendingFolderCreates = [...snap.pendingFolderCreates];
  pendingRenames = JSON.parse(JSON.stringify(snap.pendingRenames));
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

async function loadParts() {
  partSelect.innerHTML = `<option disabled>Loading…</option>`;
  try {
    const res = await fetch(`/api/parts?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      partSelect.innerHTML = `<option disabled>Error: ${data.error || "failed to load parts"}</option>`;
      return;
    }
    partsById = {};
    data.parts.forEach((p) => { partsById[p.id] = p; });
    if (!data.parts.length) {
      partSelect.innerHTML = `<option disabled>No parts found - is this a Part Studio tab?</option>`;
      return;
    }
    partSelect.innerHTML = data.parts.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  } catch (err) {
    partSelect.innerHTML = `<option disabled>Error: ${err.message}</option>`;
  }
}

async function loadTree() {
  treePane.innerHTML = `<div style="opacity:0.5;">Loading…</div>`;
  const res = await fetch("/api/tree");
  const { entries } = await res.json();
  treeEntries = entries || [];
  if (!treeLoadedOnce) {
    // Default every folder to collapsed the first time the tree loads
    treeEntries.filter((e) => e.type === "folder").forEach((e) => collapsedPaths.add(e.path));
    treeLoadedOnce = true;
  }
  renderTree();
}

stageBtn.addEventListener("click", () => {
  const selected = Array.from(partSelect.selectedOptions);
  if (!selected.length) return;
  for (const opt of selected) {
    const info = partsById[opt.value];
    staged.push({
      id: crypto.randomUUID(),
      partId: info.partId, // every staged part comes from THIS Part Studio (ctx) - no per-part source tracking needed anymore
      partName: opt.textContent,
      name: opt.textContent,       // editable filename, defaults to part name
      replaceTarget: null,
      destinationPath: null,
      archiveMode: deleteInsteadCheck.checked ? "delete" : "archive", // what happens to the file it replaces - defaults from the settings checkbox, overridable per-card via the 🗄/🗑 toggle
    });
  }
  snapshot();
  renderStage();
});

// ---------- tree rendering (nested by path, with pending create/rename/delete overlaid) ----------

// Builds the tree the user currently SEES: real entries from GitHub, with
// pending renames/moves applied, pending new folders added, and '.gitkeep'
// placeholders hidden. Nothing here touches the server - it's all local
// until Upload is clicked.
function computeVirtualEntries() {
  let entries = treeEntries
    .filter((e) => !e.path.endsWith("/.gitkeep"))
    .map((e) => ({ realPath: e.path, path: e.path, type: e.type }));

  entries = entries.map((e) => {
    for (const realPath of Object.keys(pendingRenames)) {
      const r = pendingRenames[realPath];
      if (e.realPath === realPath) return { ...e, path: r.newPath };
      if (r.isFolder && e.realPath.startsWith(realPath + "/")) {
        return { ...e, path: r.newPath + e.realPath.slice(realPath.length) };
      }
    }
    return e;
  });

  for (const folderPath of pendingFolderCreates) {
    if (!entries.some((e) => e.path === folderPath)) {
      entries.push({ realPath: null, path: folderPath, type: "folder", __pendingNew: true });
    }
  }
  return entries;
}

function buildNestedTree(entries) {
  const root = {};
  for (const e of entries) {
    const parts = e.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join("/");
      if (!node[part]) {
        node[part] = { __children: {}, __isFile: false, __path: fullPath, __realPath: fullPath, __pendingNew: false };
      }
      if (isLast) {
        node[part].__isFile = e.type === "file";
        node[part].__realPath = e.realPath !== undefined ? e.realPath : fullPath;
        node[part].__pendingNew = !!e.__pendingNew;
      }
      node = node[part].__children;
    });
  }
  return root;
}

// Renames/moves any staged reference (a not-yet-created folder path, or a
// staged file's chosen destination) so state stays consistent when the user
// renames or drags a folder that other pending actions already point into.
function remapDisplayPath(oldPath, newPath) {
  const rewrite = (p) => (p === oldPath ? newPath : (p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p));
  pendingFolderCreates = pendingFolderCreates.map(rewrite);
  staged.forEach((s) => {
    if (s.destinationPath) s.destinationPath = rewrite(s.destinationPath);
    if (s.replaceTarget) s.replaceTarget = rewrite(s.replaceTarget);
  });
  for (const key of Object.keys(pendingRenames)) {
    pendingRenames[key].newPath = rewrite(pendingRenames[key].newPath);
  }
}

// Point a tree entry (file or folder, real or pending-new) at a new path -
// used by both inline rename and drag-to-reorganize.
function retargetEntry(entry, newPath) {
  if (newPath === entry.__path) return;
  if (entry.__pendingNew) {
    remapDisplayPath(entry.__path, newPath);
  } else {
    pendingRenames[entry.__realPath] = { newPath, isFolder: !entry.__isFile };
  }
  snapshot();
  renderTree();
}

let editingTreePath = null;   // display path of the row currently showing an inline rename input
let creatingFolderIn = null;  // display path of the folder currently showing an inline "new folder" input (or "" for root), null = none

function renderTree() {
  const nested = buildNestedTree(computeVirtualEntries());
  treePane.innerHTML = `
    <div class="tree-header">
      <span style="opacity:0.5; font-size:10px;">repo root</span>
      <span class="icon-btn" id="newFolderBtn" title="New folder">＋</span>
    </div>
    <div id="treeRoot"></div>
  `;
  const treeRoot = document.getElementById("treeRoot");
  treeRoot.appendChild(renderNode(nested, 0, ""));
  if (creatingFolderIn === "") treeRoot.appendChild(buildInlineCreateRow(""));

  // allow dropping a dragged tree item onto empty space / the root to move it to top level
  treeRoot.addEventListener("dragover", (e) => {
    if (!draggingTreePath) return;
    e.preventDefault();
  });
  treeRoot.addEventListener("drop", (e) => {
    if (!draggingTreePath) return;
    e.preventDefault();
    handleTreeMoveDrop("", e);
  });

  document.getElementById("newFolderBtn").addEventListener("click", () => {
    collapsedPaths.delete("");
    creatingFolderIn = "";
    renderTree();
  });
}

function buildInlineCreateRow(parentPath) {
  const row = document.createElement("div");
  row.className = "row folder";
  row.style.marginLeft = "14px";
  row.style.cursor = "default";
  row.innerHTML = `${FOLDER_SVG}`;
  const input = document.createElement("input");
  input.className = "tree-inline-input";
  input.placeholder = "Folder name";
  row.appendChild(input);
  const commit = () => {
    const val = input.value.trim();
    if (val) {
      const full = parentPath ? `${parentPath}/${val}` : val;
      if (!pendingFolderCreates.includes(full)) {
        pendingFolderCreates.push(full);
        snapshot();
      }
    }
    creatingFolderIn = null;
    renderTree();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { creatingFolderIn = null; renderTree(); }
  });
  input.addEventListener("blur", commit);
  setTimeout(() => input.focus(), 0);
  return row;
}

const FOLDER_SVG = `<svg class="tree-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 3.5h4l1.5 2h7v7h-12.5z"/></svg>`;
const FILE_SVG = `<svg class="tree-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>`;
const collapsedPaths = new Set();
let treeLoadedOnce = false;
let draggingTreePath = null; // display path of the tree row currently being dragged (for move/reorganize)

// ---------- Onshape-style horizontal nesting drag ----------
// Instead of separate "drop on this exact spot" targets, hovering any row picks
// a default target (the row's own folder - i.e. same level as what you're
// hovering), and dragging sideways from where the drag STARTED walks up/down
// the ancestor chain: drag right = one level deeper (only possible if you're
// hovering an folder that's currently expanded), drag left = pull out to a
// shallower folder, all the way out to the repo root.
const NEST_STEP_PX = 18;
let dragBadge = null;

function ancestorFolders(path) {
  // folder paths from root ("") up to (not including) path's own parent container
  const parts = path.split("/").slice(0, -1);
  const chain = [""];
  let cur = "";
  for (const p of parts) { cur = cur ? `${cur}/${p}` : p; chain.push(cur); }
  return chain;
}

function computeDropTarget(entry, isFile, clientX, rowLeft) {
  const chain = ancestorFolders(entry.__path);
  const canNestInside = !isFile && !collapsedPaths.has(entry.__path); // only open folders are nest-able targets
  const options = canNestInside ? [...chain, entry.__path] : chain;
  const defaultIndex = chain.length - 1; // "same folder as the thing I'm hovering"
  // Anchored per-hovered-row (not per-drag-start): hovering a row's own icon
  // is the sibling-level baseline (steps=0), regardless of where the drag began
  // or which path the pointer took to get here.
  const steps = rowLeft == null ? 0 : Math.round((clientX - rowLeft) / NEST_STEP_PX);
  const targetIndex = Math.max(0, Math.min(options.length - 1, defaultIndex + steps));
  return { folder: options[targetIndex], isReplaceCandidate: isFile && steps === 0, targetPath: options[targetIndex] };
}

function showDragBadge(text, x, y) {
  if (!dragBadge) dragBadge = document.getElementById("dragHint");
  if (!dragBadge) return;
  dragBadge.textContent = text;
  dragBadge.style.left = (x + 10) + "px";
  dragBadge.style.top = (y - 24) + "px";
  dragBadge.style.display = "block";
}
function hideDragBadge() {
  if (dragBadge) dragBadge.style.display = "none";
}

// Highlights the .tree-line of the ancestor folder currently targeted by a
// drag, so the user gets live visual feedback on where a drop will land.
let highlightedTargetPath = null;
function setTargetLineHighlight(path) {
  if (path === highlightedTargetPath) return;
  if (highlightedTargetPath !== null) {
    const prevRow = document.querySelector(`.row[data-path="${CSS.escape(highlightedTargetPath)}"]`);
    prevRow?.parentElement?.querySelector(".tree-line")?.classList.remove("target-line");
  }
  highlightedTargetPath = path;
  if (path) {
    const row = document.querySelector(`.row[data-path="${CSS.escape(path)}"]`);
    row?.parentElement?.querySelector(".tree-line")?.classList.add("target-line");
  }
}
function clearTargetLineHighlight() { setTargetLineHighlight(null); }

document.addEventListener("dragend", () => { hideDragBadge(); clearTargetLineHighlight(); });

// Shared drop-target binding used by every tree row (file or folder). Handles
// both a staged file being dropped in, and an existing tree item being moved.
function bindDropTarget(el, entry, isFile) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    const rowLeft = el.getBoundingClientRect().left;
    const { folder, isReplaceCandidate, targetPath } = computeDropTarget(entry, isFile, e.clientX, rowLeft);
    el.classList.toggle("dragover", isReplaceCandidate);
    setTargetLineHighlight(isReplaceCandidate ? null : targetPath);
    showDragBadge(isReplaceCandidate ? `replace ${entry.__path.split("/").pop()}` : (folder === "" ? "→ repo root" : `→ ${folder}`), e.clientX, e.clientY);
  });
  el.addEventListener("dragleave", () => el.classList.remove("dragover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("dragover");
    hideDragBadge();
    clearTargetLineHighlight();
    const rowLeft = el.getBoundingClientRect().left;
    const { folder, isReplaceCandidate } = computeDropTarget(entry, isFile, e.clientX, rowLeft);
    if (e.dataTransfer.types.includes("application/x-tree-move")) {
      handleTreeMoveDrop(folder, e); // moving an existing item never "replaces" - it always lands in the chosen folder
      return;
    }
    const stagedId = e.dataTransfer.getData("application/x-staged-id") || e.dataTransfer.getData("text/plain");
    if (isReplaceCandidate) assignReplacement(stagedId, entry.__path, el);
    else assignDestination(stagedId, folder);
  });
}

function renderNode(node, depth, parentPath) {
  const wrap = document.createElement("div");
  for (const key of Object.keys(node).sort()) {
    const entry = node[key];
    const isFile = entry.__isFile;
    const hasChildren = Object.keys(entry.__children).length > 0;
    const isCollapsed = collapsedPaths.has(entry.__path);
    const isDeleted = isFile ? pendingDeletes.includes(entry.__realPath) : pendingFolderDeletes.includes(entry.__realPath);

    const row = document.createElement("div");
    row.className = "tree-node";
    row.innerHTML = `<div class="tree-line"></div>`;

    const inner = document.createElement("div");
    inner.className = "row" + (isFile ? "" : " folder") + (entry.__pendingNew ? " pending-new" : "") + (isDeleted ? " pending-delete" : "");
    inner.dataset.path = entry.__path;
    inner.draggable = editingTreePath === null;

    if (editingTreePath === entry.__path) {
      inner.innerHTML = `<span class="row-label" style="flex:1;">${isFile ? FILE_SVG : FOLDER_SVG}</span>`;
      const input = document.createElement("input");
      input.className = "tree-inline-input";
      input.value = key;
      inner.querySelector(".row-label").appendChild(input);
      const commit = () => {
        const val = input.value.trim();
        editingTreePath = null;
        if (val && val !== key) {
          const newPath = parentPath ? `${parentPath}/${val}` : val;
          retargetEntry(entry, newPath);
        } else {
          renderTree();
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { editingTreePath = null; renderTree(); }
      });
      input.addEventListener("blur", commit);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      inner.innerHTML = `
        <span class="row-label">
          <span class="tree-toggle">${!isFile ? (isCollapsed ? "▸" : "▾") : ""}</span>
          ${isFile ? FILE_SVG : FOLDER_SVG}
          ${key}${entry.__pendingNew ? " (new)" : ""}${isDeleted ? " (will delete)" : ""}
        </span>
        <span class="row-actions">
          ${!isFile ? '<span class="addsub-icon" title="New subfolder">＋</span>' : ""}
          <span class="rename-icon" title="Rename">✎</span>
          <span class="delete-icon" title="${isFile ? "Delete" : "Delete folder"}">🗑</span>
        </span>
      `;

      if (!isFile) {
        inner.querySelector(".tree-toggle").addEventListener("click", (e) => {
          e.stopPropagation();
          if (collapsedPaths.has(entry.__path)) collapsedPaths.delete(entry.__path);
          else collapsedPaths.add(entry.__path);
          renderTree();
        });
      }

      inner.querySelector(".rename-icon").addEventListener("click", (e) => {
        e.stopPropagation();
        editingTreePath = entry.__path;
        renderTree();
      });

      inner.querySelector(".delete-icon").addEventListener("click", (e) => {
        e.stopPropagation();
        if (isFile) toggleFileDelete(entry);
        else toggleFolderDelete(entry);
      });

      const addSub = inner.querySelector(".addsub-icon");
      if (addSub) {
        addSub.addEventListener("click", (e) => {
          e.stopPropagation();
          collapsedPaths.delete(entry.__path);
          creatingFolderIn = entry.__path;
          renderTree();
        });
      }

      // dragging THIS row to reorganize the tree
      inner.addEventListener("dragstart", (e) => {
        draggingTreePath = entry.__path;
        e.dataTransfer.setData("application/x-tree-move", entry.__path);
        e.stopPropagation();
      });
      inner.addEventListener("dragend", () => { draggingTreePath = null; });
    }

    // drop target behavior - same horizontal nesting logic for both files and folders
    bindDropTarget(inner, entry, isFile);

    row.appendChild(inner);
    if (!isFile && !isCollapsed) {
      const childWrap = document.createElement("div");
      childWrap.style.marginLeft = "10px";
      if (hasChildren) childWrap.appendChild(renderNode(entry.__children, depth + 1, entry.__path));
      if (!hasChildren && creatingFolderIn !== entry.__path) {
        // an empty folder still needs a visible, droppable target so you can
        // actually get files/subfolders into it, not just a bare row
        const emptyHint = document.createElement("div");
        emptyHint.className = "empty-drop";
        emptyHint.textContent = "drop files or folders here";
        bindFolderDropTarget(emptyHint, entry);
        childWrap.appendChild(emptyHint);
      }
      if (creatingFolderIn === entry.__path) childWrap.appendChild(buildInlineCreateRow(entry.__path));
      row.appendChild(childWrap);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function bindFolderDropTarget(el, entry) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("dragover"); });
  el.addEventListener("dragleave", () => el.classList.remove("dragover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("dragover");
    if (e.dataTransfer.types.includes("application/x-tree-move")) {
      handleTreeMoveDrop(entry.__path, e);
      return;
    }
    const stagedId = e.dataTransfer.getData("application/x-staged-id") || e.dataTransfer.getData("text/plain");
    assignDestination(stagedId, entry.__path);
  });
}

function handleTreeMoveDrop(destFolderPath, e) {
  const path = draggingTreePath || e.dataTransfer.getData("application/x-tree-move");
  if (!path) return;
  const entry = findVirtualEntryByPath(path);
  if (!entry) return;
  if (destFolderPath === path || destFolderPath.startsWith(path + "/")) return; // can't drop a folder into itself
  const baseName = path.split("/").pop();
  const newPath = destFolderPath ? `${destFolderPath}/${baseName}` : baseName;
  retargetEntry(entry, newPath);
}

// Look up a node (with __path/__realPath/__isFile/__pendingNew) in the current virtual tree by its display path
function findVirtualEntryByPath(targetPath) {
  const nested = buildNestedTree(computeVirtualEntries());
  const parts = targetPath.split("/");
  let node = nested;
  let found = null;
  for (const part of parts) {
    if (!node[part]) return null;
    found = node[part];
    node = node[part].__children;
  }
  return found;
}

function toggleFileDelete(entry) {
  const idx = pendingDeletes.indexOf(entry.__realPath);
  if (idx === -1) pendingDeletes.push(entry.__realPath);
  else pendingDeletes.splice(idx, 1);
  snapshot();
  renderTree();
}

function toggleFolderDelete(entry) {
  if (entry.__pendingNew) {
    // cancel a not-yet-created folder outright, and detach anything staged into it
    pendingFolderCreates = pendingFolderCreates.filter((p) => p !== entry.__path && !p.startsWith(entry.__path + "/"));
    staged.forEach((s) => {
      if (s.destinationPath === entry.__path || (s.destinationPath || "").startsWith(entry.__path + "/")) s.destinationPath = null;
    });
  } else {
    const idx = pendingFolderDeletes.indexOf(entry.__realPath);
    if (idx === -1) pendingFolderDeletes.push(entry.__realPath);
    else pendingFolderDeletes.splice(idx, 1);
  }
  snapshot();
  renderTree();
}

// ---------- staging pane ----------

let editingId = null;     // which staged card is currently in inline-rename mode
let draggingStagedId = null;

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
      const dest = item.replaceTarget
        ? ` → replaces ${item.replaceTarget.split("/").pop()}`
        : (item.destinationPath ? ` → ${item.destinationPath}/` : "");
      card.innerHTML = `
        <span class="row-label">${FILE_SVG} ${item.name}${dest}</span>
        <span class="row-actions">
          ${item.replaceTarget ? `<span class="mode-icon" title="${item.archiveMode === "delete" ? "Old file will be deleted - click to archive instead" : "Old file will be archived - click to delete instead"}">${item.archiveMode === "delete" ? "🗑" : "🗄"}</span>` : ""}
          <span class="rename-icon" title="Rename">✎</span>
          <span class="unstage-icon" title="Remove" style="color:#e5534b;">✕</span>
        </span>
      `;
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        draggingStagedId = item.id;
        e.dataTransfer.setData("application/x-staged-id", item.id);
        e.dataTransfer.setData("text/plain", item.id); // fallback for older drop targets
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        draggingStagedId = null;
      });

      // reordering: drag one staged card above/below another
      card.addEventListener("dragover", (e) => {
        if (!draggingStagedId || draggingStagedId === item.id) return;
        e.preventDefault();
        const rect = card.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        card.classList.toggle("drop-before", before);
        card.classList.toggle("drop-after", !before);
      });
      card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
      card.addEventListener("drop", (e) => {
        if (!e.dataTransfer.types.includes("application/x-staged-id")) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove("drop-before", "drop-after");
        const draggedId = e.dataTransfer.getData("application/x-staged-id");
        if (!draggedId || draggedId === item.id) return;
        const draggedIdx = staged.findIndex((s) => s.id === draggedId);
        if (draggedIdx === -1) return;
        const [draggedItem] = staged.splice(draggedIdx, 1);
        let targetIdx = staged.findIndex((s) => s.id === item.id);
        const rect = card.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        if (!before) targetIdx++;
        staged.splice(targetIdx, 0, draggedItem);
        snapshot();
        renderStage();
      });

      const modeIcon = card.querySelector(".mode-icon");
      if (modeIcon) {
        modeIcon.addEventListener("click", () => {
          item.archiveMode = item.archiveMode === "delete" ? "archive" : "delete";
          snapshot();
          renderStage();
        });
      }
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
  // little "flies off" cue on the tree row to signal it'll be archived/deleted on commit
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
  const renamesArr = Object.entries(pendingRenames)
    .map(([oldPath, r]) => ({ oldPath, newPath: r.newPath, isFolder: r.isFolder }))
    .filter((r) => r.oldPath !== r.newPath);

  if (!staged.length && !pendingDeletes.length && !pendingFolderDeletes.length && !pendingFolderCreates.length && !renamesArr.length) {
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

  const partRef = (s) => ({ partId: s.partId }); // every part comes from `ctx` (the open Part Studio), sent once below - not per-part anymore

  const items = staticCheck.checked
    ? [{
        parts: staged.map(partRef),
        isStatic: true,
        name: staged[0]?.name || "Static Export",
        replaceTarget: staged.find((s) => s.replaceTarget)?.replaceTarget || null,
        destinationPath: staged.find((s) => s.destinationPath)?.destinationPath || null,
        archiveMode: staged[0]?.archiveMode || "archive",
        formatName,
      }]
    : staged.map((s) => ({
        parts: [partRef(s)],
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
      body: JSON.stringify({
        deletes: pendingDeletes,
        folderDeletes: pendingFolderDeletes,
        folderCreates: pendingFolderCreates,
        renames: renamesArr,
        items,
        context: ctx, // documentId/workspaceOrVersion/workspaceOrVersionId/elementId of the Part Studio this panel is open on - every export comes from here
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail ? `${data.error || "Commit failed"} — ${data.detail}` : (data.error || "Commit failed"));
    setStatus("Done:\n" + data.results.map((r) => `${r.path} — ${r.action}`).join("\n"));
    staged = [];
    pendingDeletes = [];
    pendingFolderDeletes = [];
    pendingFolderCreates = [];
    pendingRenames = {};
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

// Full reset + reload, run once on first init AND every time the active repo changes
refreshRepoData = () => {
  staged = [];
  pendingDeletes = [];
  pendingFolderDeletes = [];
  pendingFolderCreates = [];
  pendingRenames = {};
  editingId = null;
  editingTreePath = null;
  creatingFolderIn = null;
  collapsedPaths.clear();
  treeLoadedOnce = false;
  history = []; historyIndex = -1;
  renderStage();
  loadParts();
  loadTree();
  snapshot();
};
refreshRepoData();
}

checkAuth();
