# Workspace manifests (`wmux.workspace.json`)

A workspace manifest describes a whole dev setup — which panes, in which folders, running which commands, with which browser tabs — in a file that lives in the repo. Commit it, and anyone who clones the repo brings the same setup up with one command:

```bash
wmux workspace open            # in the repo (or: wmux workspace open path/to/repo)
```

Or from the command palette: **Open workspace file…**

wmux looks for `wmux.workspace.json` at the root of the repo, or `.wmux/workspace.json`.

## The file

```jsonc
{
  "version": 1,
  "name": "platform",
  "layout": "grid",                         // optional: grid | columns | rows | left | down
  "panes": [
    { "id": "infra", "run": ["docker compose up db redis"] },
    {
      "id": "api",
      "cwd": "apps/api",                    // relative to the repo; must stay inside it
      "runOnce": ["pnpm install"],          // first open on this machine only
      "run": ["pnpm dev"],                  // every open
      "after": ["infra"],                   // start after these panes' commands were sent
      "waitFor": { "port": 5432, "timeoutMs": 60000 },
      "env": { "PORT": "4000", "API_TOKEN": "${env:API_TOKEN}" }
    },
    {
      "id": "web",
      "cwd": "apps/web",
      "run": ["pnpm dev"],
      "after": ["api"],
      "waitFor": { "http": "http://localhost:4000/health" }
    },
    { "id": "agent", "title": "Claude", "run": ["claude"] }
  ],
  "browser": { "tabs": ["http://localhost:5173", "http://localhost:4000/docs"], "active": 0 }
}
```

Comments and trailing commas are allowed. A single-service project needs very little:

```json
{ "version": 1, "panes": [ { "run": ["npm run dev"] }, { "run": ["claude"] } ], "browser": { "tabs": ["http://localhost:3000"] } }
```

| Field | Meaning |
|---|---|
| `panes[].id` | Name used by `after` (letters, digits, `.`, `_`, `-`). Defaults to `pane-1`, `pane-2`… |
| `panes[].title` | Tab label. Defaults to the id. |
| `panes[].cwd` | Folder, relative to the repo. Absolute paths and `..` are refused. |
| `panes[].run` | Commands typed in order, every time the manifest is opened. One command per entry. |
| `panes[].runOnce` | Commands typed only the first time this manifest is opened on this machine, before `run`. |
| `panes[].env` | Extra environment for that pane's shell. `${env:NAME}` reads `NAME` from wmux's own environment when the pane starts — use it for anything secret: the file is committed. |
| `panes[].after` | Ids of panes whose commands must be sent first. Cycles are refused. |
| `panes[].waitFor` | Exactly one of `{ "port": N }`, `{ "http": "http://localhost:…" }` (any answer below 500), `{ "delay": ms }`. Only this machine can be waited on. `timeoutMs` defaults to 60 s, max 10 min. |
| `browser.tabs` | Pages opened as tabs of a browser pane; `active` picks the one in front. |

At most 8 panes per workspace, browser pane included.

## Trust: nothing runs before you say so

A manifest arrives with `git clone`, so wmux treats it as untrusted:

- The first time you open one, wmux shows **every folder and every command, exactly as they will be typed**, and asks. You can run them, open the layout **without running anything**, or cancel.
- Your answer is remembered for that file's exact content, in wmux's own data folder — never in the repo, so a repo cannot mark itself trusted.
- **Any change to the file asks again**, listing the commands that were added or removed.
- There is no flag to skip the question. It is a wmux dialog, so nothing running in a terminal (an AI agent included) can answer it for you.

## When something doesn't come up

- A pane waiting on `after` / `waitFor` says so in yellow, and so does one whose wait timed out. A timed-out pane runs nothing; the panes after it still start.
- A `cwd` that doesn't exist opens at the repo root and says so.
- Opening a manifest that is already open focuses it instead of starting everything twice. `wmux workspace open --new` opens a second copy.
- Commands are not saved into wmux's session: after a wmux restart the layout comes back, and `wmux workspace open` brings the processes up again (asking first if the file changed).

## Other commands

```bash
wmux workspace open --dry-run          # print the resolved plan; run nothing
wmux workspace validate [path]         # check the file
wmux workspace save [--to <dir|file>]  # write the current workspace as a manifest
wmux workspace list                    # manifests trusted on this machine
```

`save` writes each pane's folder and its **startup commands**. Set those on a live pane with a right-click on its tab → **Startup command…**. Those also run whenever that pane is restored, which is useful on its own, without a manifest.
