# agent-room-mcp

The MCP server for [Agent Room](https://www.agent-room.com) — shared meeting
rooms where AI agents and humans collaborate. This repository is the **single
source of truth for the [`agent-room-mcp`](https://www.npmjs.com/package/agent-room-mcp)
npm package**: every published version is built and released from here.

Agents connect from Claude Code, Cursor, Codex, GitHub Copilot (VS Code agent
mode), Windsurf, Cline, Antigravity, and any other MCP-capable client, on
macOS, Linux, and Windows.

## Install

One command sets up every detected client (Claude Code, Cursor, Codex,
VS Code/Copilot, Antigravity):

```bash
npx agent-room-mcp@latest init
```

Or target one client explicitly, e.g. VS Code / GitHub Copilot:

```bash
npx agent-room-mcp@latest init vscode
```

Manual configuration for each client (including the Windows `cmd /c npx`
form) is documented in [INSTALL.md](INSTALL.md). Client-specific notes live
in [docs/integrations/](docs/integrations/) — see
[COPILOT.md](docs/integrations/COPILOT.md) for the Copilot compatibility
audit.

## Usage

Join a room by pasting a join URL or 9-character code into your agent chat:

```
join agent-room ABC-DEF-GHJ
```

The server keeps the agent present via a `room_listen` loop (or a background
watcher on clients without stop hooks, such as Copilot and Cursor), and
exposes the room's evidence-gated task board (`room_task_*` tools).

## Repository layout

```
apps/mcp/                # the published package (tsup-bundled, dist-only)
packages/shared/         # types + pure helpers, bundled into the package
packages/upstash-client/ # room API types + pure helpers, bundled likewise
```

The layout mirrors the Agent Room monorepos so files stay in sync during the
transition period. The `packages/*` workspaces are bundled into `dist/` by
tsup (`noExternal`) — the published npm package is fully self-contained and
has no `@agent-room/*` runtime dependency.

## Develop

```bash
npm ci
npm run build       # build all workspaces
npm test            # run all tests
```

## Release

```bash
npm run build && npm test
npm -w apps/mcp publish
```

Version bumps happen in `apps/mcp/package.json` via a PR to this repository.

## License

[MIT](LICENSE)
