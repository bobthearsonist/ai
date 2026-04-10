---
name: ai-repo-management
description: Use when creating skills or agents, understanding where skills live, syncing external skills, editing local.yaml or external-skills.yaml, or troubleshooting why a skill isn't loading. Triggers on "create skill", "new agent", "ai repo", "sync skills", "add skill", "local.yaml", "external-skills".
---

# AI Repository Management

Manage the AI repository at `~/AI/` — skill placement, collection syncing, and manifest integrity.

## Repository Structure

```
~/AI/
├── skills/                     # Symlinks to skills (created by sync.sh)
├── agents/                     # Symlinks to agents (created by sync.sh)
├── rules/                      # Simple constraints (<10 lines)
├── prompts/                    # Standalone prompts
├── external-skills.yaml        # Git-fetched + internal skill manifest
├── local.yaml                  # Machine-specific collections (gitignored)
├── scripts/sync.sh             # Syncs everything into skills/ and agents/
└── .external-cache/            # Git clone cache (gitignored)
```

**`skills/` is gitignored.** All skills are symlinked in by `sync.sh` from their source repos. Never create skills directly in `~/AI/skills/`.

## Where Skills Live (Source of Truth)

| Skill Type | Source Location | Configured In | Example |
|-----------|---------------|--------------|---------|
| **Internal** (framework) | `~/AI/skills/<name>/` checked into AI repo | `external-skills.yaml` as `type: internal` | `ai-repo-management`, `skill-promotion` |
| **Git-fetched** | Remote git repo, cloned to `.external-cache/` | `external-skills.yaml` as `type: git` | `skill-creator` (from anthropics/skills) |
| **Private** (personal) | `ai-private` repo at `C:\Repositories\ai-private\skills\` | `local.yaml` under `collections.private.skills` | `design-patterns`, `diagrams`, `job-hunt` |
| **Work** (Profisee) | Work skills repo (from `local.yaml` `work.skills_path`) | `local.yaml` under `collections.work.skills` | `dev-utilities`, `profisee-devops` |

`sync.sh` reads both `external-skills.yaml` and `local.yaml`, then creates symlinks in `~/AI/skills/`.

## Creating a New Skill

### Step 1: Choose the right repo

| If the skill is... | Put it in... | Configure in... |
|--------------------|-------------|-----------------|
| Personal / cross-project | `ai-private/skills/<name>/` | `local.yaml` → `collections.private.skills` |
| Profisee work-specific | Work skills repo (`profisee-ai/skills/<name>/`) | `local.yaml` → `collections.work.skills` |
| AI framework (repo management, syncing) | `~/AI/skills/<name>/` directly | `external-skills.yaml` as `type: internal` |
| From a remote git repo | Remote repo | `external-skills.yaml` as `type: git` |

### Step 2: Create the skill files

```
<repo>/skills/<name>/
  SKILL.md              # Required — frontmatter + content
  supporting-file.*     # Only if needed (heavy reference, tools)
```

### Step 3: Register the skill

**For private/work skills** — add to `local.yaml`:
```yaml
collections:
  private:
    skills:
      - <name>          # Simple: source dir name = symlink name
      # OR with rename:
      - source: <dir-name>
        name: <symlink-name>
```

**For internal skills** — add to `external-skills.yaml`:
```yaml
skills:
  - name: <name>
    type: internal
    description: Brief description
```

**For git-fetched skills** — add to `external-skills.yaml`:
```yaml
skills:
  - name: <name>
    type: git
    source: https://github.com/org/repo.git
    branch: main
    path: skills/<name>
    target: skills/<name>
```

### Step 4: Sync

```bash
cd ~/AI && ./scripts/sync.sh
```

This creates the symlink in `~/AI/skills/<name>` pointing to the source.

## Component Types

| Type   | When to Create                                    |
|--------|---------------------------------------------------|
| Skill  | Has procedures, substantial knowledge (>10 lines) |
| Rule   | Simple constraint, <10 lines, no procedures       |
| Agent  | Composing skills for specific context              |

## Troubleshooting

**Skill not loading?**
1. Check symlink exists: `ls -la ~/AI/skills/<name>`
2. If missing, check it's listed in `local.yaml` or `external-skills.yaml`
3. Run `./scripts/sync.sh` and check for errors
4. Verify source directory exists at the path configured

**Sync failing?**
- `yq` must be installed (sync.sh uses it to parse YAML)
- On Windows: `MSYS=winsymlinks:nativestrict` is set automatically
- Git-fetched skills need network access for first clone

## Quick Validation

```bash
cd ~/AI

# Sync all skills and agents
./scripts/sync.sh

# Check for broken symlinks
find skills/ -maxdepth 1 -type l ! -exec test -e {} \; -print

# List all registered skills
echo "=== external-skills.yaml ===" && yq '.skills[].name' external-skills.yaml
echo "=== local.yaml collections ===" && yq '.collections[].skills[]' local.yaml
```
