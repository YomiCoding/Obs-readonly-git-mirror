# Read-only Git Mirror

Mirror a Git repository into your Obsidian vault — one way, read-only.

Useful when a team publishes a knowledge base as a Git repository and readers should
always see the latest version without ever pushing anything back.

## What it does

- Pulls a branch of a Git repository into the vault folder, on startup and every 60 seconds.
- **Never commits, never pushes.** A read-only token is enough.
- **Never touches files the repository does not track.** Keep your own notes in a folder
  that does not exist in the repository and they are safe.
- Files the repository *does* track are overwritten on every sync — the remote is the
  source of truth for those. Files removed from the remote are removed locally too, so
  the vault does not accumulate stale copies.
- Shows the sync state in the status bar, and says why when it fails. Silent staleness is
  the worst failure mode for a tool like this, so failures are always visible.

## Network use

This plugin talks to exactly one remote: the Git repository URL you configure. Nothing
else. There is **no telemetry, no analytics**, and no update mechanism of its own —
updates come through Obsidian.

Credentials you enter are stored in this plugin's `data.json` inside your vault, in plain
text — the same way a Git remote URL with an embedded token would be. **Use a read-only
token.**

## Setup

1. Create a new, empty vault dedicated to the mirror (recommended). Obsidian's vault
   switcher then lets you move between it and your own vaults, and nothing is ever written
   into your own notes. The welcome note a new vault starts with is fine to leave in place.
   If you would rather keep the mirror inside an existing vault, set a **target folder** in
   the settings; the plugin refuses to mirror into the root of a vault that already holds
   other files.
2. Install and enable the plugin in that vault.
3. Open Settings → Read-only Git Mirror.
4. Either paste the one-line **setup code** your administrator gave you, or fill in the
   repository URL, username and token by hand.

Administrators can also hand out a link that configures everything in one click:

```
obsidian://readonly-git-mirror?config=<base64url of the setup JSON>
```

The setup JSON looks like this:

```json
{
  "repoUrl": "https://example.com/team/handbook.git",
  "tokenUser": "reader",
  "token": "a-read-only-token",
  "targetDir": "",
  "sparseFile": ".mirror-sparse",
  "hidePaths": []
}
```

`targetDir` empty means the vault root (a dedicated vault); a folder name puts the mirror in
that subfolder of whichever vault the plugin runs in.

**That link contains the token. Treat it as a credential** — anyone who gets it can read
the repository.

## Hiding parts of the repository

If the repository contains files meant for tooling rather than readers, it can ship a
sparse list (default file name `.mirror-sparse`) in Git non-cone format:

```
/*
!/AGENTS.md
!/build/
```

Top-level paths listed with `!` are not written to disk. The file name is configurable
via `sparseFile`, and `hidePaths` supplies a fallback list for repositories that do not
ship one. Adding a path to the list later removes it from disk on the next sync.

## What it is not

- Not a two-way sync. Local edits to tracked files are discarded, by design.
- Not a backup tool. It never writes to the remote.

## Limitations

- **Desktop only.** The plugin needs Node's file system; mobile is not supported.
- **Requires Obsidian 1.13 or newer** (it uses the declarative settings API, so its settings
  show up in Obsidian's settings search).
- Shallow clone (`depth: 1`); history is not available locally.
- Large repositories are slow and memory-hungry, because the Git implementation is pure
  JavaScript ([isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)).
- HTTP(S) remotes only. SSH is not supported.

## Development

```bash
npm install
npm test        # unit + integration tests
npm run build   # produces dist/main.js and dist/manifest.json
```

## License

MIT
