# GitHub Copilot CLI

Configure GitHub Copilot CLI to use this repo's shared instructions, skills, agents, hooks, and MCP configuration.

This page is for the **terminal Copilot CLI** (`copilot`). VS Code's native Copilot Chat uses VS Code settings and `mcp.json`; see [Client support](client-support.md#github-copilot-in-vs-code) for that surface.

## Shared AI repo paths

| Content | Source of truth |
| --- | --- |
| Instructions | `~/AI/AGENTS.md` |
| Skills | `~/AI/skills` |
| Agents | `~/AI/agents` |
| Permissions | `~/AI/permissions/permissions.yaml` |

## Copilot CLI paths

| Type | User path | Notes |
| --- | --- | --- |
| Instructions | `~/.copilot/copilot-instructions.md` | Loaded in all CLI sessions. |
| Additional instructions | `~/.copilot/instructions/**/*.instructions.md` | Optional extra instruction files. |
| Skills | `~/.copilot/skills/*/SKILL.md` | Recommended user-level skill location. |
| Agents | `~/.copilot/agents/` | Optional user-level custom agent profiles. |
| Hooks | `~/.copilot/hooks/*.json` or `hooks` in `~/.copilot/settings.json` | Loaded when the CLI starts. |
| Settings | `~/.copilot/settings.json` | User settings; do not symlink this file. |
| MCP | `~/.copilot/mcp-config.json` | Managed by `/mcp`; separate from VS Code `mcp.json`. |
| Saved permissions | `~/.copilot/permissions-config.json` | Runtime approvals; not the shared permissions source. |

Copilot CLI also reads project-local instructions from `AGENTS.md`, `.github/copilot-instructions.md`, and `.github/instructions/**/*.instructions.md` in the current directory or git root.

## Recommended wiring

### Windows PowerShell

Run from a normal PowerShell session:

```powershell
$ai = Join-Path $HOME 'AI'

New-Item -ItemType Directory -Force -Path "$HOME\.copilot" | Out-Null

# Shared instructions.
if (Test-Path "$HOME\.copilot\copilot-instructions.md") {
  $item = Get-Item "$HOME\.copilot\copilot-instructions.md" -Force
  if ($item.LinkType -ne 'SymbolicLink') {
    throw "$HOME\.copilot\copilot-instructions.md exists and is not a symlink. Move it before linking."
  }
  Remove-Item "$HOME\.copilot\copilot-instructions.md" -Force
}
New-Item -ItemType SymbolicLink `
  -Path "$HOME\.copilot\copilot-instructions.md" `
  -Target "$ai\AGENTS.md" | Out-Null

# Shared skills. If this exists as a real directory, back it up before replacing.
if (Test-Path "$HOME\.copilot\skills") {
  $item = Get-Item "$HOME\.copilot\skills" -Force
  if (-not $item.LinkType) {
    throw "$HOME\.copilot\skills exists and is not a link. Back it up before linking."
  }
  Remove-Item "$HOME\.copilot\skills" -Force
}
New-Item -ItemType SymbolicLink `
  -Path "$HOME\.copilot\skills" `
  -Target "$ai\skills" | Out-Null
```

If directory symlinks require Developer Mode or elevation on your machine, use a same-volume junction for directories instead:

```powershell
cmd /c mklink /J "%USERPROFILE%\.copilot\skills" "%USERPROFILE%\AI\skills"
```

Keep `copilot-instructions.md` as a file symlink or a managed copy; junctions are directory-only.

Optional agents:

```powershell
if (-not (Test-Path "$HOME\.copilot\agents")) {
  New-Item -ItemType SymbolicLink `
    -Path "$HOME\.copilot\agents" `
    -Target "$HOME\AI\agents" | Out-Null
}
```

Only add the agents link if you use Copilot CLI user agents.

### macOS/Linux

```bash
mkdir -p ~/.copilot

[ -e ~/.copilot/copilot-instructions.md ] || \
  ln -s ~/AI/AGENTS.md ~/.copilot/copilot-instructions.md

[ -e ~/.copilot/skills ] || \
  ln -s ~/AI/skills ~/.copilot/skills
```

Optional agents:

```bash
[ -e ~/.copilot/agents ] || \
  ln -s ~/AI/agents ~/.copilot/agents
```

## Settings

Use `/settings` in Copilot CLI or edit `~/.copilot/settings.json`.

Common settings:

```json
{
  "model": "gpt-5.5",
  "effortLevel": "xhigh",
  "contextTier": "long_context",
  "renderMarkdown": true
}
```

Do **not** symlink `settings.json` as a file. Copilot writes settings with normal application semantics, and file symlinks for actively-written config are fragile. If shared settings are needed later, use an explicit sync script or a parent-directory strategy designed for writable config.

## Hooks

Copilot CLI supports user-level hooks in:

```text
~/.copilot/hooks/*.json
```

or inline in:

```text
~/.copilot/settings.json
```

Hook files use:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [],
    "preToolUse": [],
    "postToolUse": [],
    "notification": []
  }
}
```

Notes:

- Hook config changes are loaded when Copilot CLI starts.
- `preToolUse` can allow, deny, or modify tool arguments.
- `postToolUse`, `sessionStart`, and `notification` can inject additional context.
- PascalCase hook names such as `PreToolUse` use Claude-compatible payload fields and matcher semantics.
- Do not copy Claude Code hooks blindly; confirm payload fields and tool names in the Copilot hooks reference first.

## Graphify

The shared `AGENTS.md` contains the authoritative graphify behavior:

- Walk up from the current directory to find the nearest `graphify-out/graph.json`.
- Query ancestor graphs explicitly with `graphify query "<q>" --graph <path-to-graph.json>` or by changing to the graph root.
- Prefer `graphify query`, `graphify path`, and `graphify explain` before raw grep/read for codebase questions.
- After code changes, run `graphify update .` when applicable.

`graphify copilot install` is **skill-only**. It copies:

```text
graphify/skill-copilot.md -> ~/.copilot/skills/graphify/SKILL.md
graphify references       -> ~/.copilot/skills/graphify/references/
.graphify_version         -> ~/.copilot/skills/graphify/.graphify_version
```

It does not install Copilot hooks, edit `AGENTS.md`, edit `~/.copilot/copilot-instructions.md`, edit VS Code settings, or install git hooks.

If Copilot starts ignoring the ancestor-walk rule in practice, prefer a lightweight `sessionStart` hook that finds the nearest ancestor graph and injects that path into context. Use git hooks, not Copilot hooks, for graph freshness/rebuild automation.

## MCP

Copilot CLI uses:

```text
~/.copilot/mcp-config.json
```

Manage it with:

```text
/mcp
```

This is separate from VS Code's native Copilot MCP config:

```text
%APPDATA%\Code\User\mcp.json
%APPDATA%\Code - Insiders\User\mcp.json
```

Use `~/AI/permissions/permissions.yaml` as the human-edited source of truth, then sync/apply it to the specific client config.

## Validation

From Copilot CLI:

```text
/env
/instructions
/skills
/mcp
```

From PowerShell:

```powershell
Get-Item "$HOME\.copilot\copilot-instructions.md" -Force |
  Select-Object FullName, LinkType, Target

Get-Item "$HOME\.copilot\skills" -Force |
  Select-Object FullName, LinkType, Target

copilot help config
copilot help environment
```

Expected local wiring on this machine:

```text
~/.copilot/copilot-instructions.md -> ~/AI/AGENTS.md
~/.copilot/skills                 -> ~/AI/skills
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Instructions not followed | Run `/instructions` and verify `~/.copilot/copilot-instructions.md` or `~/AI/AGENTS.md` is loaded. Restart Copilot after changing symlinks. |
| Skills not visible | Run `/skills`; verify `~/.copilot/skills` points at `~/AI/skills` and `SKILL.md` files have valid frontmatter. |
| Hooks not firing | Run `/env` to inspect loaded hooks; validate JSON; restart Copilot after changes. |
| Graphify not prioritized | Confirm `AGENTS.md` graphify section is loaded and that an ancestor `graphify-out/graph.json` exists. |
| MCP missing | Run `/mcp`; inspect `~/.copilot/mcp-config.json`; remember VS Code `mcp.json` is separate. |
