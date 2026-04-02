# AI Repository

Central repository for AI-assisted development configuration: **Instructions**, **Skills**, **Agents**, and **Memory**.

## Client Comparison

This section documents how each AI coding client loads instructions, skills, and agents.

### Quick Reference

| Feature | OpenCode | Claude Code | GitHub Copilot | Cline |
|---------|----------|-------------|----------------|-------|
| **Instructions file** | `AGENTS.md` | `CLAUDE.md` | `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md` | `.clinerules` |
| **Global instructions** | `~/.config/opencode/AGENTS.md` | `~/.claude/CLAUDE.md` | `chat.instructionsFilesLocations` | N/A |
| **Skills support** | Yes (`SKILL.md`) | Yes (`SKILL.md`) | Yes (Agent Skills) | No |
| **Custom agents** | Yes (`.md` files) | Yes (subagents) | Yes (custom agents) | No |
| **Config format** | `opencode.json` | `settings.json` | VS Code settings | `.clinerules` |

---

## OpenCode

### Instructions Loading

| File | Location | When Loaded |
|------|----------|-------------|
| `AGENTS.md` | Workspace root (walks up to git root) | Always, auto-applied |
| `AGENTS.md` | `~/.config/opencode/AGENTS.md` | Always, combined with project |
| Custom files | Via `opencode.json` `instructions` array | Always, supports globs and URLs |

**Config example** (`opencode.json`):
```json
{
  "instructions": [
    "CLAUDE.md",
    "docs/guidelines.md",
    ".cursor/rules/*.md",
    "https://example.com/shared-rules.md"
  ]
}
```

### Skills Loading

| Location | Scope | Discovery |
|----------|-------|-----------|
| `.opencode/skill/<name>/SKILL.md` | Project | Walks up from cwd to git root |
| `~/.config/opencode/skill/<name>/SKILL.md` | Global | Always available |
| `.claude/skills/<name>/SKILL.md` | Project | Claude-compatible path |
| `~/.claude/skills/<name>/SKILL.md` | Global | Claude-compatible path |

**How it works**: Skills are discovered at startup (name + description only). The `skill` tool lists available skills; agents call `skill({ name: "skill-name" })` to load full content on-demand.

**SKILL.md frontmatter**:
```yaml
---
name: my-skill          # Required: lowercase, hyphens, 1-64 chars
description: What it does  # Required: 1-1024 chars
license: MIT              # Optional
compatibility: opencode   # Optional
metadata:                 # Optional: string-to-string map
  author: me
---
```

### Agents Loading

| Location | Scope |
|----------|-------|
| `~/.config/opencode/agent/*.md` | Global |
| `.opencode/agent/*.md` | Project |

**Agent frontmatter**:
```yaml
---
description: What the agent does
mode: primary | subagent
model: claude-sonnet-4
temperature: 0.2
tools:
  write: true
  edit: true
  bash: false
permission:
  skill: allow
---
```

---

## Claude Code

### Instructions Loading

| File | Location | When Loaded |
|------|----------|-------------|
| `CLAUDE.md` | Workspace root | Always, auto-applied |
| `CLAUDE.md` | `~/.claude/CLAUDE.md` | Always, combined with project |
| `CLAUDE.md` | `.claude/CLAUDE.md` in subdirs | Per-directory overrides |

### Skills Loading

| Location | Scope | Priority |
|----------|-------|----------|
| Managed (enterprise) | Organization-wide | 1 (highest) |
| `~/.claude/skills/<name>/SKILL.md` | Personal/global | 2 |
| `.claude/skills/<name>/SKILL.md` | Project | 3 |
| Plugin `skills/` directory | Where plugin installed | 4 (lowest) |

**How it works**: Claude discovers skills by name + description. When a request matches, Claude asks to use the skill, then loads full `SKILL.md` content.

**SKILL.md frontmatter**:
```yaml
---
name: my-skill            # Required
description: What and when  # Required (used for matching)
allowed-tools: Read, Grep   # Optional: restrict tools
model: claude-sonnet-4      # Optional: override model
context: fork               # Optional: run in subagent
hooks:                      # Optional: lifecycle hooks
  PreToolUse: [...]
---
```

**Additional features**:
- `allowed-tools`: Limit which tools skill can use
- `context: fork`: Run skill in isolated subagent context
- `user-invocable: false`: Hide from slash menu but allow programmatic use
- Progressive disclosure: Reference supporting files that load on-demand

### Subagents Loading

| Location | Scope |
|----------|-------|
| `~/.claude/agents/<name>.md` | Personal/global |
| `.claude/agents/<name>.md` | Project |
| `--agents` CLI flag | Session only |
| Plugin `agents/` directory | Where plugin installed |

---

## GitHub Copilot

### Instructions Loading

| File | Location | When Loaded |
|------|----------|-------------|
| `AGENTS.md` | Anywhere in repo (nearest to file wins) | Agent mode |
| `CLAUDE.md` | Repo root | Agent mode (alternative) |
| `GEMINI.md` | Repo root | Agent mode (alternative) |
| `.github/copilot-instructions.md` | Repo | Always for chat |
| `*.instructions.md` | `.github/instructions/` | Conditional via `applyTo` glob |
| Personal instructions | VS Code settings | Always |

**Path-specific instructions** (`.github/instructions/typescript.instructions.md`):
```yaml
---
applyTo: "**/*.ts,**/*.tsx"
excludeAgent: "code-review"  # Optional: exclude from specific agent
---
Your TypeScript-specific instructions here.
```

### Skills Loading (Agent Skills)

Copilot supports Agent Skills similar to Claude Code. Skills are discovered and invoked based on description matching.

| Location | Scope | Notes |
|----------|-------|-------|
| `.github/skills/<name>/SKILL.md` | Workspace | Recommended project location |
| `.claude/skills/<name>/SKILL.md` | Workspace | Legacy/Claude-compatible |
| `~/.copilot/skills/<name>/SKILL.md` | User/global | Recommended personal location |
| `~/.claude/skills/<name>/SKILL.md` | User/global | Legacy/Claude-compatible |

**VS Code settings to enable**:
```json
{
  "chat.useAgentsMdFile": true,
  "chat.useAgentSkills": true,
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.agentSkillsLocations": {
    "~/ai/skills": true
  },
  "chat.agentFilesLocations": {
    "~/ai/agents": true
  },
  "chat.instructionsFilesLocations": {
    "/path/to/ai/AGENTS.md": true
  }
}
```

> **Note**: `chat.agentSkillsLocations` provides a direct path to skills without relying on symlinks. The `~/.copilot/skills/` and `~/.claude/skills/` paths are also searched automatically. `chat.instructionsFilesLocations` loads AGENTS.md as instruction context in every workspace globally.

### Custom Agents

Copilot supports custom agents for the coding agent feature. See [GitHub docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents).

---

## Cline

### Instructions Loading

| File | Location | When Loaded |
|------|----------|-------------|
| `.clinerules` | Project root | When editing files in that project |

**How it works**: Cline searches upward from current file to find nearest `.clinerules`. Only ONE file is active at a time (no merging).

**Example** (`.clinerules`):
```markdown
## Active Agent: Homelab Admin

Reference these folders visible in your workspace:
- 🤖 AI: networking - Network configuration guidelines
- 🤖 AI: global-rules - Security best practices

## Project-Specific Rules
1. All NAS configurations must be version controlled
```

**No skills support**: Cline doesn't have a native skills system. Use workspace folder references instead.

---

## Unified Setup (This Repository)

### Directory Structure

```
~/ai/
├── AGENTS.md                    # Master instructions (all clients via symlinks)
├── claude/
│   └── settings.json            # Claude Code shared settings (cross-platform)
├── permissions/
│   └── permissions.yaml         # Canonical permissions source of truth
├── skills/                      # Flat structure for Claude Code compatibility
│   ├── ai-client-config/        # In-repo skills
│   ├── ai-repo-management/
│   ├── permissions-yaml/
│   ├── skill-promotion/
│   ├── skill-creator/           # External (git-fetched)
│   └── .../                     # External (symlinks from collections)
├── agents/
│   ├── skill-builder.md         # In-repo agent
│   └── .../                     # External (symlinks from collections)
├── memory/
│   └── memory.jsonl             # Persistent memory (MCP)
├── rules/                       # Simple constraints
└── prompts/                     # Standalone prompts
```

### Claude Code Config Stack

Claude Code merges settings from multiple layers. This repo provides the **shared** layer; machine-specific overrides go in `settings.local.json` (not tracked here).

| File | Location | Purpose |
|------|----------|---------|
| `settings.json` | `~/.claude/settings.json` (symlink -> `~/ai/claude/settings.json`) | Shared cross-platform: hooks, permissions, toolApprovalSettings |
| `settings.local.json` | `~/.claude/settings.local.json` (machine-specific, not synced) | Platform-specific: statusLine, additionalDirectories, MCP tool approvals |

**What goes where:**

| Setting | `settings.json` (shared) | `settings.local.json` (per-machine) |
|---------|--------------------------|--------------------------------------|
| Hooks (SessionStart, PreToolUse) | X | |
| Command permissions (Bash, Git, etc.) | X | |
| Tool permissions (Read, Glob, etc.) | X | |
| Sensitive path ask rules | X | |
| `statusLine` | | X |
| `additionalDirectories` | | X |
| Platform-specific paths | | X |
| MCP gateway tool approvals | | X |

### Symlinks Setup

**macOS:**
```bash
# Claude Code
ln -sf ~/ai/AGENTS.md ~/.claude/claude.md
ln -sf ~/ai/claude/settings.json ~/.claude/settings.json
ln -sf ~/ai/agents ~/.claude/agents
ln -sf ~/ai/skills ~/.claude/skills

# GitHub Copilot (recommended personal skills path)
mkdir -p ~/.copilot
ln -sf ~/ai/skills ~/.copilot/skills
```

**Windows (PowerShell):**
```powershell
# OpenCode agents (junction, no admin required)
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\agent" "$env:USERPROFILE\ai\agents\opencode"

# Claude Code CLAUDE.md -> AGENTS.md (requires admin OR gsudo)
gsudo New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Target "$env:USERPROFILE\ai\AGENTS.md"

# Claude Code settings.json
gsudo New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\settings.json" -Target "$env:USERPROFILE\ai\claude\settings.json"

# Claude Code agents (junction, no admin required)
cmd /c mklink /J "$env:USERPROFILE\.claude\agents" "$env:USERPROFILE\ai\agents"

# Claude Code skills (symlink to flat skills directory)
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills" -Target "$env:USERPROFILE\ai\skills"

# GitHub Copilot skills (symlink to shared skills - requires chat.useAgentSkills enabled)
cmd /c mklink /J "$env:USERPROFILE\.copilot\skills" "$env:USERPROFILE\ai\skills"

# OpenCode reads Claude-compatible paths automatically, so skills work without additional symlinks
```

> **Note**: GitHub Copilot Agent Skills require `chat.useAgentSkills: true` in VS Code settings. The `chat.agentSkillsLocations` setting provides an additional direct path without relying on these symlinks.

### File Purposes

| File | Purpose |
|------|---------|
| `AGENTS.md` | Universal agent instructions (memory, todos, thinking, anti-patterns) |
| `claude/settings.json` | Claude Code shared settings (hooks, permissions, tool approvals) |
| `permissions/permissions.yaml` | Canonical permissions source of truth for all AI clients |
| `skills/*/SKILL.md` | Procedural knowledge, loaded on-demand when task matches |
| `agents/opencode/*.md` | OpenCode agents (also used by Claude Code via symlink) |
| `memory/memory.jsonl` | Persistent memory storage (MCP) |

## Setup

After cloning, run the setup script once:

```bash
./setup.sh
```

This configures git hooks for automatic external skill syncing and performs initial sync.

**Requirements:** `yq` (install with `brew install yq`)

## Architecture

This repository uses a **hybrid approach**:

- **Skills** - Active capabilities with knowledge AND procedures (HOW to do something)
- **Agents** - Composed bundles of skills for specific contexts
- **Rules** - Simple constraints (DO/DON'T guidance, no procedures needed)

```
~/ai/
├── skills/                     # Flat structure (Claude Code compatible)
│   ├── ai-client-config/       # In-repo skills
│   ├── ai-repo-management/
│   ├── permissions-yaml/
│   ├── skill-promotion/
│   ├── skill-creator/          # External (git-fetched)
│   └── .../                    # External (symlinks from collections)
│
├── agents/
│   ├── skill-builder.md        # In-repo agent
│   └── .../                    # External (symlinks from collections)
│
├── rules/                      # Simple constraints (<10 lines)
│   ├── global/
│   └── domain/
│
├── prompts/                    # Standalone prompts (referenced by agents)
│   └── system/
│
├── scripts/sync.sh             # Syncs external skills + collection symlinks
├── external-skills.yaml        # Git-fetched skill manifest
├── local.yaml                  # Machine-specific collections (gitignored)
└── docs/                       # Architecture documentation
```

## Shell Integration

The repo includes `init.bash` and `init.ps1` at the root for shell-level integrations. Source them from your shell profile:

**Bash / Zsh** (add to `~/.bashrc` or `~/.zshrc`):
```bash
[ -f "$HOME/AI/init.bash" ] && source "$HOME/AI/init.bash"
```

**PowerShell** (add to `$PROFILE`):
```powershell
. (Join-Path $HOME AI/init.ps1)
```

### What They Provide

| Feature | Command | Description |
|---------|---------|-------------|
| OpenCode Build Switcher | `opencode --use list` | Switch between npm release and local dev worktree builds |
| | `opencode --use <name>` | Activate a specific worktree build (partial name match) |
| | `opencode --use reset` | Return to npm release build |
| Context Lens Routing | (automatic) | Routes OpenCode through mitmproxy if running on :8080 |

See [New Machine Setup](docs/new-machine-setup.md) for installation instructions.

## When to Use What

| Use        | When                                                       |
| ---------- | ---------------------------------------------------------- |
| **Skills** | Content has step-by-step procedures, substantial knowledge |
| **Rules**  | Simple constraints, <10 lines, no procedures needed        |
| **Agents** | Domain specialists that load relevant skills               |

## Agent Format

Top-level agents (`agents/*.md`) use a minimal frontmatter for broad client compatibility:

```yaml
---
name: my-agent
description: What the agent does
---

Agent instructions in markdown...
```

Agents under `agents/opencode/` use the OpenCode-specific format with additional fields:

```yaml
---
description: What the agent does
mode: primary | subagent
model: claude-sonnet-4
temperature: 0.2
tools:
  write: true
  edit: true
  bash: false
  skill: true
permission:
  skill: allow
---

Agent instructions in markdown...
```

## Quick Start

### Using an Agent in OpenCode

Press `Tab` to cycle through available agents, or use `@agent-name` to invoke a subagent.

### Available Agents

| Agent | Mode | Purpose |
|-------|------|----------|
| `skill-builder` | subagent | Converts memory observations into skills |

### In-Repo Skills

| Skill              | Description                 |
| ------------------ | --------------------------- |
| `ai-client-config` | AI client configuration paths |
| `ai-repo-management` | AI repo structure management |
| `permissions-yaml` | Unified AI tool permissions |
| `skill-promotion`  | Promote memory to skills    |

### External Skills

Fetched from upstream repositories via `external-skills.yaml`:

| Skill           | Source                       | Description                    |
| --------------- | ---------------------------- | ------------------------------ |
| `skill-creator` | anthropics/skills (GitHub)   | Create new skills              |

### Collections

Additional skills and agents can be composed from local repos via `local.yaml`. Collections are machine-specific (gitignored) — see `local.yaml.example` for configuration.

Syncing happens automatically on `git checkout` and `git pull` after running `./setup.sh`.

To manually sync: `./scripts/sync.sh`

## Rules (Simple Constraints)

Simple markdown files, no skill structure needed:

- `rules/global/shell.md`
- `rules/global/security.md`
- `rules/global/files.md`
- `rules/global/explain.md`
- `rules/global/todo.md`
- `rules/domain/network/net-guidelines.md`
- `rules/domain/home-assistant/ha-guidelines.md`

## Documentation

- [New Machine Setup](docs/new-machine-setup.md)
- [Skills & Agents Architecture](docs/skills-agents-architecture.md)
- [Migration Guide](docs/migration-guide.md)
- [Context Lens Setup](docs/context-lens-setup.md)
- [Schema Definitions](docs/schemas/)
- [How Cline Uses Rules](HOW_CLINE_USES_RULES.md)

## Related

**AI Infrastructure** (`ai-infrastructure/`): MCPs, gateways, task agents, and platform services.
