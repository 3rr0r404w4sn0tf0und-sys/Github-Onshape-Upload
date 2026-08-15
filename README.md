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
