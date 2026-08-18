# Onshape → GitHub Side Panel App

A side panel that lives inside an Onshape **Part Studio** tab and exports
selected parts straight into a GitHub repo — with drag-to-replace,
archive-or-delete for replaced files, merging multiple parts into one file,
per-user OAuth on both sides, and a choice of export format.

Created by WanChengJunWang · [source repo](https://github.com/3rr0r404w4sn0tf0und-sys/Github-Onshape-Upload) · licensed under [AGPLv3](./LICENSE)

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
- **File format choice**: STEP, STL, OBJ, Parasolid, IGES, SolidWorks
  (SolidWorks export is currently untested).
- **Customizable commit messages**: an optional prefix that replaces
  `feat:`/`chore:` on every message a batch generates, and an optional
  extended description appended under the summary line on every commit
  (GitHub shows this as bold summary + regular-text body below) — both
  remembered across sessions.
- **Undo/redo** (Ctrl+Z / Ctrl+Y) for everything staged before you commit.
- One **Upload to GitHub** click commits the whole batch — renames, deletes,
  folder creates, archives, and new/replaced files — in one pass. Each step
  is applied and reported individually, so a single failure part-way
  through doesn't silently take the rest of the batch down with it; the
  status log shows exactly what succeeded, what didn't, and why.
- **Rate limited** (sign-in, commits, and general API use each have their
  own ceiling) so a runaway script or scraper can't hammer your GitHub/
  Onshape API usage or database.

## How dragging works

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
9. Optionally set a **commit prefix** and/or **commit description** in
   settings if you want the commits this batch makes to look different
   from the defaults (`{filename}` is replaced per file in the
   description).
10. Ctrl+Z / Ctrl+Y to undo/redo staging changes (nothing already committed).
11. **Upload to GitHub** commits the whole batch in one pass.

## Fixed issues (changelog)

Roughly newest first — kept here so anyone picking this repo back up has
context on what's already been chased down.

- **Customizable commit prefix/description** — the settings pane now has
  fields for an optional commit-message prefix (replaces `feat:`/`chore:`
  on every message a batch generates) and an optional extended commit
  description (appended under the summary line on every commit in the
  batch, `{filename}` supported). Both are remembered across sessions.
- **Rate limiting added** — sign-in, commits, and general API routes each
  now have their own request ceiling (`express-rate-limit`), so a script
  hammering the app can't run up GitHub/Onshape API usage or database load
  unchecked. No effect on normal interactive use.
- **CSRF protection on OAuth flows** — both the GitHub and Onshape sign-in
  flows now round-trip a random per-session `state` value and verify it on
  callback, closing a theoretical session-fixation gap that existed when
  the callback just trusted whatever `code` showed up.
- **Path traversal guard on the commit batch** — every path in a commit
  request (deletes, renames, folder creates, destinations) is now
  validated before any write happens, rejecting anything containing a
  `..` segment or a leading `/`. Nothing in the UI generates a path like
  that today; this is a backstop against a tampered/malformed request.
- **Partial commit failures no longer take down the whole batch** — each
  step in `/api/commit` (renames, deletes, folder creates, per-part
  export+upload, archive/delete of replaced files) is now applied and
  reported individually instead of one failure throwing out of the whole
  handler. A batch of 10 staged items where one fails now still commits
  the other 9, and the status log shows exactly which ones succeeded,
  which failed, and why — instead of an all-or-nothing 500 that left you
  guessing what actually landed in the repo. Replacements also now write
  the new file *before* archiving/deleting the old one, so a failed export
  or write can never cost you both.
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

## Privacy

This app connects to real GitHub and Onshape accounts, so here's exactly
what it can see and what it stores.

**GitHub** — your username and avatar, plus full read/write access to your
repositories (that's what the `repo` OAuth scope grants). The app only
ever touches the one repo you actively select in the panel, but the token
itself isn't scoped narrower than that by GitHub.

**Onshape** — your profile and read-only access to your documents, used to
list parts in the currently open Part Studio and export them. The app
never writes to, deletes, or modifies anything in Onshape.

**Stored server-side** (Postgres, tied to your session cookie, kept for
~1 year unless you sign out or clear cookies):
- GitHub username, avatar URL, and access token
- Onshape access + refresh tokens
- Your default/active repo selection

No email address is collected. Nothing is sold or shared with third
parties. Tokens are only ever used to carry out actions initiated in the
panel (staging/uploading) — see [`server.js`](./server.js) for exactly
where each token is used. The full policy also lives in its own file:
[`PRIVACY.md`](./PRIVACY.md). The same notice is shown in-app on first
use, and re-openable anytime via the "Privacy" link in the panel's
footer.

## Terms of Service

This app is provided as-is with no warranty, and you're responsible for
reviewing staged changes before committing — it can create, rename,
overwrite, archive, and delete files in whatever repo you select. Full
terms: [`TERMS.md`](./TERMS.md). Shown in-app right after the privacy
notice on first use, and re-openable anytime via the "Terms" link in the
panel's footer.

## License

AGPLv3 — see [`LICENSE`](./LICENSE). Because this runs as a network
service, anyone interacting with a deployed instance is entitled to the
source corresponding to what's actually running (AGPL §13); the footer
link in the panel itself points back to this repo for that reason.
