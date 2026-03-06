# Unified AI Tool Permissions

Single source of truth for MCP servers and command permissions across all AI coding assistants.

## Supported Clients

| Client | MCP | Commands | Config Location |
|--------|-----|----------|-----------------|
| Claude Code | ✅ | ✅ | `~/.claude/settings.json` |
| GitHub Copilot | ✅ | ✅ | `%APPDATA%/Code/User/mcp.json` + `settings.json` |
| OpenCode | ✅ | ✅ | `~/.config/opencode/opencode.json` |
| Cline | ✅ | ❌ | `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Kilo Code | ✅ | ✅ | `globalStorage/kilocode.kilo-code/settings/mcp_settings.json` + `settings.json` |

## Usage

Ask AI to apply `permissions.yaml` to a specific client:

> "Apply my permissions.yaml config to Claude Code"
> "Sync MCP servers from permissions.yaml to all my AI tools"
> "Add the memory server from permissions.yaml to Copilot"

## File: permissions.yaml

The canonical configuration. Contains:

- **mcp_servers** - MCP server definitions (command, args, env, auto_approve)
- **additional_directories** - Directories AI can access beyond workspace
- **tools** - Native tool permissions (read, write, glob, etc.)
- **commands** - Shell command permissions (allow/ask/deny)

### Key Features

- `{{HOME}}` placeholder expands to user's home directory
- `auto_approve` list for Cline/Kilo tool auto-approval
- `disabled: true` to skip a server in certain clients
- Pattern matching: `git status*` matches any command starting with "git status"

### Permission Levels

| Level | Description |
|-------|-------------|
| `allow` | Auto-approved, no prompt |
| `ask` | Requires user confirmation |
| `deny` | Always blocked |

## Client Format Differences

### Claude Code
- Permissions as `mcp__servername__*` and `Bash(command:*)`

### GitHub Copilot
- MCP in `mcp.json`, commands in `chat.tools.terminal.autoApprove`

### OpenCode
- Full JSON config with `permission.bash` object (allow/ask/deny per pattern)

### Cline/Kilo
- MCP with `autoApprove` arrays per server, Kilo has `allowedCommands` in settings
