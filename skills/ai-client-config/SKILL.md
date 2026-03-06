---
name: ai-client-config
description: AI coding client configuration paths and setup. Use when setting up symlinks for AI clients, troubleshooting why instructions/skills aren't loading, understanding where each client looks for config files, configuring MCP servers, or syncing configurations across OpenCode, Claude Code, GitHub Copilot, and Cline.
---

# AI Client Configuration

Where each AI coding client looks for instructions, skills, agents, and MCP server configs.

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
| **MCP** | `.mcp.json` | `~/.claude/.mcp.json` + `~/.claude/settings.local.json` (`enabledMcpjsonServers`) |

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

- Server definitions: `~/.claude/.mcp.json` (or project-level `.mcp.json`)
- Server enable/disable: `~/.claude/settings.local.json` → `enabledMcpjsonServers` array

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

## Unified Symlink Strategy

Share skills across all clients from a single canonical location:

| Source | Target | Clients |
|--------|--------|---------|
| `~/ai/skills/` | `~/.copilot/skills/` | GitHub Copilot |
| `~/ai/skills/` | `~/.claude/skills/` | Claude Code, OpenCode |
| `~/ai/AGENTS.md` | `~/.claude/CLAUDE.md` | Claude Code |
| `~/ai/agents/` | `~/.claude/agents/` | Claude Code |
| `~/ai/agents/opencode/` | `~/.config/opencode/agent/` | OpenCode |
