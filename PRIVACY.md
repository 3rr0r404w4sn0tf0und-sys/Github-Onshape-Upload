# Privacy Notice

This app connects to real GitHub and Onshape accounts, so here's exactly
what it can see and what it stores.

## GitHub

Your username and avatar, plus full read/write access to your
repositories (that's what the `repo` OAuth scope grants). The app only
ever touches the one repo you actively select in the panel, but the
token itself isn't scoped narrower than that by GitHub.

## Onshape

Your profile and read-only access to your documents, used to list parts
in the currently open Part Studio and export them. The app never writes
to, deletes, or modifies anything in Onshape.

## Stored server-side

Kept in Postgres, tied to your session cookie, retained for ~1 year
unless you sign out or clear cookies:

- GitHub username, avatar URL, and access token
- Onshape access + refresh tokens
- Your default/active repo selection

## What's not collected

No email address is collected. Nothing is sold or shared with third
parties. Tokens are only ever used to carry out actions initiated in the
panel (staging/uploading) — see [`server.js`](./server.js) for exactly
where each token is used.

## Where else this appears

The same notice is shown in-app on first use, and is re-openable anytime
via the "Privacy" link in the panel's footer.
