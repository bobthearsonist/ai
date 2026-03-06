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

## Syncing to Clients

After updating permissions.yaml, remind user to sync:

> "Updated permissions.yaml. To apply to clients, ask me to 'sync permissions to Claude Code' or 'sync permissions to all clients'."

See `~/ai/permissions/README.md` for client-specific sync procedures.
