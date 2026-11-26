# Client Support

`scripts/sync.sh` gathers skills and agents into this repo. AI clients need one more step: they must be configured to read those synced paths.

## Shared Paths

| Content | Shared path |
| --- | --- |
| Instructions | `~/AI/AGENTS.md` |
| Skills | `~/AI/skills` |
| Agents | `~/AI/agents` |
| Permissions | `~/AI/permissions/permissions.yaml` |

For terminal-specific setup, see [GitHub Copilot CLI](copilot-cli.md).

## GitHub Copilot in VS Code

Recommended user settings:

```json
{
  "chat.useAgentsMdFile": true,
  "chat.useAgentSkills": true,
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.agentSkillsLocations": {
    "~/AI/skills": true
  },
  "chat.agentFilesLocations": {
    "~/AI/agents": true
  },
  "chat.instructionsFilesLocations": {
    "~/AI/AGENTS.md": true
  }
}
```

Copilot also discovers project-local skills from `.github/skills/<name>/SKILL.md`.

## GitHub Copilot CLI

For the repo-backed custom status line, point user settings at the script in this repo:

The gray identity segment shows `<login> bill:@<organization>`. The Copilot
entitlement API lists every organization that grants a seat, in a fixed order,
and does not say which one is billed. With a single organization it is shown as
billed; with several, the segment shows `<login> orgs:<a>,<b>` instead of
guessing. Set `COPILOT_BILLING_ORG` (for example `export
COPILOT_BILLING_ORG=Epyon-Ltd`) in the environment that launches Copilot CLI to
name the billed organization explicitly.

Entitlement data is cached for five minutes. Authenticate GitHub CLI with the
same account used by Copilot CLI.

An MCP segment appears only when a server is unhealthy: red `mcp! <names>` for
failed servers, yellow `mcp? <names>` for servers needing auth, and dim
`mcp… <names>` while servers are still starting. Status comes from the
status-line payload when present, otherwise from the session's
`mcp-status.json` snapshot or `events.jsonl`. The snapshot is written by the
`mcp-status` extension in `copilot/extensions/`; see
[Copilot CLI extensions](copilot-cli.md#extensions) to install it. Without it,
the segment only reflects MCP warnings logged to `events.jsonl`. Set
`COPILOT_STATUSLINE_MCP_OK=1`
to also show a green `mcp:<connected>/<total>` segment when all are healthy.
`refreshInterval` re-runs the script periodically so MCP status updates between
events.

Windows:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"%USERPROFILE%\\AI\\scripts\\copilot-statusline-summary.js\"",
    "refreshInterval": 5
  },
  "footer": {
    "showCustom": true,
    "showAgent": true
  }
}
```

macOS/Linux:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/AI/scripts/copilot-statusline-summary.js",
    "refreshInterval": 5
  },
  "footer": {
    "showCustom": true,
    "showAgent": true
  }
}
```

## Claude Code

macOS/Linux:

```bash
mkdir -p ~/.claude
ln -sfn ~/AI/AGENTS.md ~/.claude/CLAUDE.md
ln -sfn ~/AI/skills-without-plugins ~/.claude/skills
ln -sfn ~/AI/agents-without-plugins ~/.claude/agents
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.claude"
cmd /c mklink "$env:USERPROFILE\.claude\CLAUDE.md" "$env:USERPROFILE\AI\AGENTS.md"
cmd /c mklink /J "$env:USERPROFILE\.claude\skills" "$env:USERPROFILE\AI\skills-without-plugins"
cmd /c mklink /J "$env:USERPROFILE\.claude\agents" "$env:USERPROFILE\AI\agents-without-plugins"
```

Claude Code loads plugins, so it reads the `*-without-plugins` views: skills and agents that a configured plugin already delivers would otherwise load twice. See [Plugins](plugins.md).

If `~/.claude/skills` already exists as a real directory, move it aside first and keep it as a backup until migration is verified.

## OpenCode

OpenCode reads `AGENTS.md` from workspaces and supports skill packages. You can either point OpenCode config at this repo's shared paths or expose the same skills through Claude-compatible paths.

Example `opencode.json`:

```json
{
  "instructions": [
    "~/AI/AGENTS.md"
  ]
}
```

OpenCode does not load plugins, so give it the full skills folder:

```bash
mkdir -p ~/.config/opencode
ln -sfn ~/AI/skills ~/.config/opencode/skills
```

OpenCode also reads `~/.claude/skills`, which leaves out plugin-delivered skills. Its own folder is registered later, and a later source replaces an earlier skill with the same ID, so each skill appears once.

## Cline

Cline does not have native Agent Skills support. Use project `.clinerules` or workspace folder references for rules and prompts that Cline should see.

## Verification

After changing client paths:

1. Restart or reload the client.
2. Run `~/AI/scripts/doctor.sh`.
3. Ask the client to list available skills.
4. Invoke one migrated skill by name to confirm the full `SKILL.md` loads.
