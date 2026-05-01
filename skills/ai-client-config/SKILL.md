---
name: ai-client-config
description: AI coding client configuration paths and setup. Use when setting up symlinks for AI clients, troubleshooting why instructions/skills aren't loading, understanding where each client looks for config files, configuring MCP servers, or syncing configurations across OpenCode, Claude Code, GitHub Copilot, and Cline.
---

# AI Client Configuration

Where each AI coding client looks for instructions, skills, agents, and MCP server configs.

## Before Making Configuration Changes

**MANDATORY for Claude Code config changes**: Before editing settings files, permissions, or MCP configuration, fetch the current official docs to verify syntax and supported features:

1. **Settings & permissions**: `WebFetch https://code.claude.com/docs/en/permissions` and `WebFetch https://code.claude.com/docs/en/settings`
2. **MCP servers**: `WebFetch https://code.claude.com/docs/en/mcp`
3. **Known issues**: Search `gh issue list --repo anthropics/claude-code -S "<topic>"` for open bugs

This skill documents what we've learned through testing, but Claude Code evolves. The official docs are the source of truth — verify before acting.

## Client Paths

### OpenCode

| Type | Workspace | User |
|------|-----------|------|
| Instructions | `AGENTS.md` | `~/.config/opencode/AGENTS.md` |
| Skills | `.opencode/skill/*/SKILL.md`, `.claude/skills/*/SKILL.md` | `~/.config/opencode/skill/*/SKILL.md`, `~/.claude/skills/*/SKILL.md` |
| Agents | `.opencode/agent/*.md` | `~/.config/opencode/agent/*.md` |
| **MCP** | `opencode.json` (`mcpServers`) | `~/.config/opencode/opencode.json` (`mcpServers`) |

### Claude Code

| Type | Workspace | User |
|------|-----------|------|
| Instructions | `CLAUDE.md` | `~/.claude/CLAUDE.md` |
| Skills | `.claude/skills/*/SKILL.md` | `~/.claude/skills/*/SKILL.md` |
| Agents | `.claude/agents/*.md` | `~/.claude/agents/*.md` |
| **MCP** | — | `~/.claude.json` via `claude mcp add --scope user` |

### GitHub Copilot

| Type | Workspace | User |
|------|-----------|------|
| Instructions | `AGENTS.md`, `.github/copilot-instructions.md` | `chat.instructionsFilesLocations` in VS Code settings |
| Skills | `.github/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md` | `~/.copilot/skills/*/SKILL.md` (recommended), `~/.claude/skills/*/SKILL.md` (legacy), `chat.agentSkillsLocations` |
| Agents | `.github/agents/*.agent.md` | `chat.agentFilesLocations` in VS Code settings |
| **MCP** | `.vscode/mcp.json` | See MCP Configuration Files below |

**Required VS Code settings**: `chat.useAgentSkills: true`, `chat.useAgentsMdFile: true`

**Additional VS Code settings**:
- `chat.agentSkillsLocations`: Add custom paths to discover skills (e.g., `"~/ai/skills": true`)
- `chat.agentFilesLocations`: Add custom paths to discover agents (e.g., `"~/ai/agents": true`)
- `chat.instructionsFilesLocations`: Add instruction files loaded globally (e.g., `"/path/to/AGENTS.md": true`)

### Cline

| Type | Workspace | User |
|------|-----------|------|
| Instructions | `.clinerules` | `~/Documents/Cline/Rules/` |
| Skills | — | — |
| Agents | — | — |
| **MCP** | — | See MCP Configuration Files below |

## MCP Configuration Files

Where each client stores its MCP server configuration. All paths shown as Windows (`%APPDATA%`) with macOS equivalents in parentheses.

### VS Code / GitHub Copilot

| Edition | Path |
|---------|------|
| Stable | `%APPDATA%\Code\User\mcp.json` (`~/Library/Application Support/Code/User/mcp.json`) |
| Insiders | `%APPDATA%\Code - Insiders\User\mcp.json` (`~/Library/Application Support/Code - Insiders/User/mcp.json`) |

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json`)

### Claude Code

- **MCP servers**: add via `claude mcp add --scope user <name> ...` — stored in `~/.claude.json` under `mcpServers`. Use `--transport http` with `--header` for HTTP gateways; default is stdio. Inspect with `claude mcp list` / `claude mcp get <name>`.
- **User settings**: `~/.claude/settings.json` — the ONLY user-level settings file. Symlink chain: `~/.claude/settings.json` → `~/ai/claude/settings.json` → (via dir symlink) `~/ai-private/claude/settings.json`. Contains: hooks, `permissions.allow`/`ask`/`defaultMode`, `enabledPlugins`, `extraKnownMarketplaces`, `enabledMcpjsonServers`, UX preferences.
  - **CRITICAL — symlink the directory, not the file.** `claude/` is a directory symlink (`ai/claude` → `ai-private/claude`), NOT a file symlink to `settings.json`. File symlinks of actively-written config files get clobbered on every save by atomic-write-rename (Claude Code writes settings via tmp-file + rename for crash safety; rename replaces the symlink with a regular file). Directory symlinks are immune — the rename happens inside the symlinked directory, never on the directory entry itself.
  - **WARNING**: `~/.claude/settings.local.json` is NOT a user-level config. It's a project-level `.claude/settings.local.json` that applies only when CWD is `~`. Do not use it for user-wide settings — especially `permissions.allow` which won't apply to other projects.
  - **Deprecated key**: `toolApprovalSettings` is silently ignored by current Claude Code. All permissions go through `permissions.allow`/`ask`/`defaultMode` exclusively.
- **Settings precedence** (highest to lowest): managed > CLI args > project `.claude/settings.local.json` > project `.claude/settings.json` > user `~/.claude/settings.json`
- **MCP auto-approve**: Use bare server name `mcp__servername` in `permissions.allow` (e.g., `mcp__mcpx` for a gateway). Wildcards (`mcp__mcpx__*`) are NOT reliably supported per anthropics/claude-code#3107.
- **Claude Code in VS Code** — all launch modes (extension, CLI, third-party agent in Copilot) use Claude Code's native MCP configuration (`~/.claude.json` mcpServers + `~/.claude/settings.json`). The Claude Agent harness brings its own config regardless of host.
  - **Third-party agent mode** (Claude running inside GitHub Copilot): still uses Claude Code's native config, NOT VS Code's `mcp.json`. Tool names and `toolApprovalSettings` are consistent across all Claude Code launch modes.
  - **VS Code native Copilot agent** (GitHub's own agent): uses VS Code's MCP configuration (`~/Library/Application Support/Code/User/mcp.json` or `.vscode/mcp.json`). These are separate from Claude Code's MCP servers.
  - **Implication**: When debugging MCP connectivity for Claude Code sessions (any mode), check `~/.claude.json` (`claude mcp list`) and `~/.claude/settings.json`. VS Code's `mcp.json` only applies to Copilot's native agent.

### Symlinking actively-written config files

Use **directory symlinks** for any path that the application writes to (settings.json, preferences, caches with autosave). A file symlink of a written-to file gets replaced with a regular file on the next write because most editors and config-writers use atomic-write-rename (write to `.tmp`, then `rename(tmp, target)`) for crash safety. The rename replaces the directory entry — including the symlink. This is OS-agnostic (happens on Linux too — vim breaks symlinks unless you set `:set backupcopy=yes`).

**Symptom**: a file symlink keeps reverting to a regular file. **Fix**: symlink the parent directory instead. Verify with:

```bash
# After the app writes to the file, the symlink should still be a symlink:
ls -la <path>     # expect: lrwxrwxrwx (not -rw-r--r--)
```

If the symlink keeps regenerating but writes still corrupt it, you have a contamination loop: something is restoring the symlink (a sync script, a post-checkout git hook) AND something is overwriting it. Either stop one of the writers or switch to a directory symlink.

### OpenCode

- User-level: `~/.config/opencode/opencode.json` → `mcpServers` section
- Project-level: `opencode.json` in project root → `mcpServers` section

### Kilo Code

| Edition | Path |
|---------|------|
| VS Code Stable | `%APPDATA%\Code\User\globalStorage\kilocode.kilo-code\settings\mcp_settings.json` |
| VS Code Insiders | `%APPDATA%\Code - Insiders\User\globalStorage\kilocode.kilo-code\settings\mcp_settings.json` |

### Cline

| Edition | Path |
|---------|------|
| VS Code extension | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Standalone | `~/.cline/data/settings/cline_mcp_settings.json` |

### Permissions

`~/ai/permissions/permissions.yaml` — centralized auto-approve list for MCP tools, synced to all clients.

## Context Lens (LLM Context Inspector)

Reverse proxy that intercepts AI coding agent API traffic and visualizes context window composition. Runs as Docker containers from `ai-infrastructure/platform/context-lens/`.

### Ports

| Port | Service | Purpose |
|------|---------|---------|
| 4040 | Context Lens Proxy | LLM API interception (base URL override) |
| 4041 | Context Lens Web UI | Treemap visualization of context composition |
| 8080 | mitmproxy | HTTPS interception for clients that can't override base URL |

### How Clients Connect

| Client | Method | Configuration |
|--------|--------|---------------|
| Claude Code (terminal) | `context-lens claude` | Wraps CLI, sets `ANTHROPIC_BASE_URL` automatically |
| Claude Code (VS Code) | Base URL override | `"claudeCode.environmentVariables": {"ANTHROPIC_BASE_URL": "http://localhost:4040/claude"}` in VS Code settings |
| OpenCode | `context-lens oc` | Wraps CLI, routes through proxy |
| GitHub Copilot | mitmproxy (:8080) | HTTPS proxy interception via `mitm_addon.py` |

### Startup

```bash
# Docker (recommended — runs both containers)
docker compose -f ~/ai-infrastructure/platform/context-lens/docker-compose.yml up -d

# Background mode (native, no Docker)
context-lens background start --no-open

# Check status
context-lens background status
context-lens doctor
```

### Analysis

```bash
context-lens analyze ~/.context-lens/data/claude-<id>.lhar
context-lens analyze <file>.lhar --json
context-lens analyze <file>.lhar --composition=pre-compaction
```

### Known Issues

- `--no-open` required on Windows Git Bash (`start` command doesn't exist in MSYS2)
- If Context Lens is not running, Claude Code in VS Code fails to connect (remove `ANTHROPIC_BASE_URL` env var)
- Windows: `spawn` without `shell: true` causes ENOENT for npm-installed tools — local patch needed in `dist/cli.js`

## Shell Integration (init.bash / init.ps1)

The AI repo includes shell integration scripts at `~/AI/init.bash` and `~/AI/init.ps1` that provide:

1. **OpenCode Build Switcher** — `opencode --use list|<num>|<name>|reset` to switch between npm release and local dev worktree builds of OpenCode
2. **Context Lens Auto-Routing** — Automatically routes OpenCode through mitmproxy on `:8080` if running, with TLS workarounds for Bun on Windows

### Setup

Source the init file from your shell profile (one line each):

| Shell | Profile File | Line to Add |
|-------|-------------|-------------|
| Bash / Zsh | `~/.bashrc` or `~/.zshrc` | `[ -f "$HOME/AI/init.bash" ] && source "$HOME/AI/init.bash"` |
| PowerShell 7 | `$PROFILE` | `. (Join-Path $HOME AI/init.ps1)` |
| PowerShell 5.1 | `$PROFILE` | `. (Join-Path $HOME AI/init.ps1)` |

### Notes

- Init files are standalone — NOT connected to `setup.sh`, `sync.sh`, or the skills system
- Bash helpers use underscore prefix (e.g., `_opencode_use`), PowerShell uses `Invoke-` verb
- Config persisted in `~/.opencode-local`
- Follows the nvm/oh-my-zsh source-from-profile pattern

## Unified Symlink Strategy

Share skills across all clients from a single canonical location:

| Source | Target | Clients |
|--------|--------|---------|
| `~/ai/skills/` | `~/.copilot/skills/` | GitHub Copilot |
| `~/ai/skills/` | `~/.claude/skills/` | Claude Code, OpenCode |
| `~/ai/AGENTS.md` | `~/.claude/CLAUDE.md` | Claude Code |
| `~/ai/agents/` | `~/.claude/agents/` | Claude Code |
| `~/ai/agents/opencode/` | `~/.config/opencode/agent/` | OpenCode |
