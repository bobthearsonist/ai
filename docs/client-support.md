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

## Claude Code

macOS/Linux:

```bash
mkdir -p ~/.claude
ln -sfn ~/AI/AGENTS.md ~/.claude/CLAUDE.md
ln -sfn ~/AI/skills ~/.claude/skills
ln -sfn ~/AI/agents ~/.claude/agents
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.claude"
cmd /c mklink "$env:USERPROFILE\.claude\CLAUDE.md" "$env:USERPROFILE\AI\AGENTS.md"
cmd /c mklink /J "$env:USERPROFILE\.claude\skills" "$env:USERPROFILE\AI\skills"
cmd /c mklink /J "$env:USERPROFILE\.claude\agents" "$env:USERPROFILE\AI\agents"
```

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

If your OpenCode version discovers Claude-compatible skills, the Claude symlink setup above is enough for global skills.

## Cline

Cline does not have native Agent Skills support. Use project `.clinerules` or workspace folder references for rules and prompts that Cline should see.

## Verification

After changing client paths:

1. Restart or reload the client.
2. Run `~/AI/scripts/doctor.sh`.
3. Ask the client to list available skills.
4. Invoke one migrated skill by name to confirm the full `SKILL.md` loads.
