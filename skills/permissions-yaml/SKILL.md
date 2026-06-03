---
name: permissions-yaml
description: Manage unified AI tool permissions in ~/ai/permissions/permissions.yaml. Use when adding auto-approve commands globally, syncing MCP servers across clients, updating command permissions (allow/ask/deny), or modifying tool permissions. Triggers on "add to auto-approve", "update permissions", "sync MCP", "allow command", "deny command".
---

# Permissions YAML Management

Canonical source of truth for AI tool permissions at `~/ai/permissions/permissions.yaml`.

## File Location

```
~/ai/permissions/permissions.yaml
```

## Structure Overview

```yaml
mcp_servers: # MCP server definitions with auto_approve lists
additional_directories: # Directories AI can access beyond workspace
tools: # Native tool permissions (read, write, edit, etc.)
commands: # Shell command permissions
  deny: [] # Always blocked
  ask: [] # Requires confirmation
  allow: [] # Auto-approved
```

## Adding Commands to Auto-Approve

When instructed to auto-approve a command globally:

1. **Read current permissions.yaml** to find the `commands.allow` section
2. **Add the command pattern** with trailing `*` for prefix matching
3. **Place in appropriate category** with a comment if starting a new group

### Command Pattern Format

- Simple command: `"git status*"` - matches `git status`, `git status -s`, etc.
- With subcommand: `"dotnet build*"` - matches `dotnet build`, `dotnet build --release`
- PowerShell cmdlet: `"Get-Service*"` - matches the cmdlet and parameters

### Example Addition

To add `git fetch` to auto-approve:

```yaml
commands:
  allow:
    # --- Git read operations ---
    - 'git status*'
    - 'git log*'
    - 'git fetch*' # ADD HERE - with related git commands
```

## Adding MCP Server Auto-Approve

When adding tools to an MCP server's auto-approve:

```yaml
mcp_servers:
  memory:
    auto_approve:
      - create_entities
      - search_nodes
      - new_tool_name # ADD HERE
```

## Workflow: Auto-Approve Addition

When user says "add X to auto-approve" or similar:

1. Determine if it's a **command** or **MCP tool**
2. For commands → add to `commands.allow` section
3. For MCP tools → add to appropriate `mcp_servers.{name}.auto_approve`
4. Preserve existing formatting and comments
5. Add near related items when possible

## Claude Code: MCP rule translation (gateway gotcha)

`permissions.yaml` is a **universal** expression. Per-backend `auto_approve` lists
translate directly in Cline/Kilo (they match per-server-per-tool). **Claude Code does
not** — translate carefully when syncing to `~/.claude/settings.json`.

Claude Code's MCP matcher supports only three rule shapes. There is **no partial/prefix
wildcard** in the tool-name portion:

| Rule | Matches |
|------|---------|
| `mcp__<server>` | all tools from that server |
| `mcp__<server>__*` | same — all tools (`*` is the whole-server form, NOT a prefix glob) |
| `mcp__<server>__<exacttool>` | one exact tool |

Anything else — e.g. `mcp__mcpx__monarch-money__*` or `mcp__mcpx__azure-devops__wit_get_*`
— is read as an **exact** tool literally named `monarch-money__*` and matches **nothing**,
so the user is prompted forever. (Bash rules DO glob at any position; MCP rules do not.)

### Gateways flatten backends into tool names

Backends reached through a gateway (`mcpx`, `agentgateway`) are **not** separate Claude
Code servers — they are tools of the one gateway server, named
`mcp__<gateway>__<backend>__<tool>`. So a YAML entry like `monarch-money` (an mcpx backend)
must translate to the **bare gateway server**, not a per-backend wildcard.

When emitting Claude Code rules:

- Gateway backend with `auto_approve: ["*"]` → emit the **bare gateway server**
  (`mcp__mcpx`, `mcp__agentgateway`). Auto-approves every tool that gateway exposes.
- Want only specific tools → list **exact** `mcp__<gateway>__<backend>__<tool>` entries.
- Standalone (non-gateway) server like `kapture` → `mcp__kapture`.
- **Never** emit `mcp__<gateway>__<backend>__*` — it silently matches nothing.

### Guard destructive tools under a whole-gateway allow

`deny -> ask -> allow`, first match wins. A broad `mcp__mcpx` allow auto-approves ALL of
that gateway's backends, including write/destructive ones. To keep the convenience but
gate specific tools, add **exact** `ask` (or `deny`) rules — they're evaluated before the
allow and win. No wildcards, and you must cover each gateway's naming form:

- mcpx (double underscore): `mcp__mcpx__memory__delete_entities`
- agentgateway (single underscore): `mcp__agentgateway__memory_delete_entities`

Typical guards: `memory__delete_*`, `hass-mcp__restart_ha`, and (per workflow)
`hass-mcp__call_service_tool` / `hass-mcp__entity_action`.

### Write to user scope only

For Claude Code, write rules to **user-level `~/.claude/settings.json`** (applies in every
directory). Do **not** create project-level `.claude/settings.local.json` files — they
fragment permissions and accumulate stray "don't ask again" captures. Reserve project-local
files for genuinely directory-scoped rules only (e.g. `Bash(ssh *)` auto-approved just in
the homelab repo). See the `feedback-no-project-level-settings` memory.

## Syncing to Clients

After updating permissions.yaml, remind user to sync:

> "Updated permissions.yaml. To apply to clients, ask me to 'sync permissions to Claude Code' or 'sync permissions to all clients'."

See `~/ai/permissions/README.md` for client-specific sync procedures.
