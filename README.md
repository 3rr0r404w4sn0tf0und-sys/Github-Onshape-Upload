# Onshape → GitHub Side Panel App

A side panel that lives inside an Onshape **Part Studio** tab and exports
selected parts straight into a GitHub repo — with drag-to-replace,
archive-or-delete for replaced files, merging multiple parts into one file,
per-user OAuth on both sides, and a choice of export format.

Created by WanChengJunWang · [source repo](https://github.com/3rr0r404w4sn0tf0und-sys/Github-Onshape-Upload) · licensed under [AGPLv3](./LICENSE)

<img width="753" height="850" alt="image" src="https://github.com/user-attachments/assets/7af312f4-ddef-4eb2-8b25-80ebdd472ada" />


## What it does

- **Signs each person in with their own GitHub and Onshape accounts** (OAuth
  on both sides) — commits are attributed to the actual person, not a shared
  bot, and every user's GitHub API usage is walled off under their own token.
- **Lists every part in the currently open Part Studio tab**, with a search
  box to filter by name, and can auto-select the matching part(s) when you
  select something in the 3D viewport.
- **Stages parts for upload**, where each staged card can be:
  - dragged onto an existing file in the repo tree to **replace** it,
  - dragged onto a folder (or the empty tree background, for repo root) to
    set where it lands,
  - renamed inline before upload,
  - merged with other staged cards into **one exported file** ("Static"),
    which can then be renamed/dragged as a single unit — unchecking Static
    splits it back into the individual cards it came from.
- **Archive or delete** whatever file a staged part replaces — archiving
  moves the old file into whatever `Archive`-named folder already exists
  next to it (any casing), falling back to creating `Archive/` if none
  exists; delete removes it outright. Toggleable per staged card, with a
  global default in settings.
- **Full repo tree management**: inline rename, new folder, delete
  file/folder, drag files and folders around to reorganize — all staged
  client-side and only touching GitHub once you actually commit.
- **File format choice**: STEP, STL, OBJ, Parasolid, IGES, SolidWorks.
- **Undo/redo** (Ctrl+Z / Ctrl+Y) for everything staged before you commit.
- One **Upload to GitHub** click commits the whole batch — renames, deletes,
  folder creates, archives, and new/replaced files — in one pass.

## How dragging works

<img width="1910" height="993" alt="image" src="https://github.com/user-attachments/assets/355bb47e-ae71-429d-9775-b72ef0be61e4" />


Modeled after VS Code's file tree / Finder / Onshape's own document
browser: **the row your cursor is over is the target**, full stop.
- Hovering a **folder row** → drop *into* that folder.
- Hovering a **file row** → targets that file's own folder, and for a
  staged card, means "replace this file."
- To land something in an ancestor folder, drop it directly on that
  ancestor's own visible row (or the empty tree background for repo root) —
  there's no pixel-offset math to fight with.

## Using it

1. Open a **Part Studio** tab in Onshape, open the right sidebar, click the
   app icon.
2. Sign in with GitHub, then with Onshape (both required).
3. Pick a repo — **Use** (this session only) or **Set default** (⭐,
   remembered for next time).
4. Select parts from the list — search to filter, or select them directly
   in the 3D viewport — then **Stage selected parts**.
5. In the tree: drag a staged card onto an existing file to replace it
   (archived to an `Archive` folder, or hard-deleted if that card's
   trash-icon is toggled into delete-mode), or onto a folder to just add it
   there.
6. Rename staged files inline (✎).
7. Check **Static** if some staged parts should merge into one exported
   file — this collapses them into a single staged card you can rename and
   drag like any other; unchecking it restores the individual cards.
8. Pick your **file format**.
9. Ctrl+Z / Ctrl+Y to undo/redo staging changes (nothing already committed).
10. **Upload to GitHub** commits the whole batch in one pass.

## Fixed issues (changelog)

Roughly newest first — kept here so anyone picking this repo back up has
context on what's already been chased down.

- **`sha` not supplied on file writes** — `putFile` now looks up the
  target path's current `sha` automatically before writing, instead of
  every write assuming the path was brand new. Fixes commits failing
  outright the moment you tried to overwrite anything that already existed
  (re-uploads, re-archiving, recreating a `.gitkeep`, renames landing on an
  existing name).
- **Archived files silently truncated to empty for large parts** —
  GitHub's Contents API doesn't reliably return file content over ~1MB
  (common for STEP/Parasolid exports of any real complexity); it just
  comes back empty with no error. `getFile` now falls back to the git
  blobs API (100MB limit) whenever that happens.
- **Onshape session expiring mid-work** — access tokens expire roughly
  hourly; the app already stored a refresh token but never used it. Any
  Onshape API call that gets a 401 now silently refreshes and retries once,
  instead of surfacing a raw `invalid_token` error.
- **Static merge not actually merging in the UI** — checking "Static"
  previously only affected the export at commit time; the staged list
  still showed separate cards. It now visibly collapses staged cards into
  one on check, and restores them on uncheck.
- **Static merge only archiving/deleting the first replaced file** — a
  merged export standing in for several old files was only cleaning up one
  of them; it now archives/deletes every file it's replacing.
- **OBJ/STL export failing with "Invalid resolution parameters were
  specified"** — mesh formats require a `resolution` param on the Onshape
  translation request that wasn't being sent; STEP/IGES/Parasolid/
  SolidWorks were unaffected.
- **Unstaging everything by selecting a different part** — a plain click
  on a new part in the native multi-select list was clearing the previous
  selection (no modifier key held), which was wired to auto-unstage.
  Unstaging is now only ever explicit, via the ✕ on a staged card.
- **Drag targeting feeling inaccurate/random** — the old system inferred
  nesting depth from horizontal drag distance from a per-row anchor that
  reset every time the pointer crossed onto a different row, so the same
  physical mouse position could resolve to different targets moment to
  moment. Replaced entirely with the file-explorer model described above.
- **Replacing a file discarding the new name/format** — `targetPath` used
  to be built from the *old* file's name; now only the destination
  *folder* carries over from the replaced file, and the filename/extension
  always comes from what you actually picked this time.
- **Assembly-based export silently exporting the whole assembly** —
  Onshape's assembly translation endpoint ignores any part filter and
  always exports everything, making a true per-part "assembly tool"
  impossible via that endpoint. The app is Part Studio-scoped by design as
  a result — see "How it's scoped" below.
- **Sessions not surviving a redeploy/restart** — originally in-memory,
  which also doesn't work across more than one server instance. Now
  Postgres-backed via Neon.

## How it's scoped

This app only ever reads from and exports the single Part Studio tab it was
opened from — never a whole Assembly. That's a deliberate tradeoff, not a
missing feature: Onshape's assembly translation endpoint ignores per-part
filtering and always exports the entire assembly regardless of which parts
you select, and in-context/composite parts authored directly inside an
assembly (with no real Part Studio backing them) aren't exportable via the
API at all. Scoping to a single Part Studio sidesteps both problems
entirely, at the cost of not being usable directly from an assembly view.

## License

AGPLv3 — see [`LICENSE`](./LICENSE). Because this runs as a network
service, anyone interacting with a deployed instance is entitled to the
source corresponding to what's actually running (AGPL §13); the footer
link in the panel itself points back to this repo for that reason.
