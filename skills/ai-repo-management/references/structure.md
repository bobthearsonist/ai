# AI Repository Management Knowledge

## Repository Structure

```
~/AI/
├── skills/                     # Active capabilities with procedures
│   ├── core/                   # Framework skills
│   │   ├── security/
│   │   └── ai-repo-management/
│   └── domain/                 # Domain-specific skills
│       ├── synology/
│       ├── keeper-commander/
│       ├── rbr40-mesh/
│       └── ai/skill-creator/   # External (from anthropics/skills)
│
├── agents/                     # Composed skill bundles
│   └── homelab-admin/
│
├── rules/                      # Simple constraints (<10 lines)
│   ├── global/
│   └── domain/
│
├── prompts/                    # Standalone prompts
│   └── system/
│
├── external-skills.yaml        # External skill manifest
├── setup.sh                    # First-time setup
├── scripts/sync.sh
├── .githooks/{post-checkout,post-merge}
└── docs/schemas/               # YAML schemas
```

## Component Types

### Skills

Active capabilities with knowledge AND procedures.

**Required files:**

- `skill.yaml` - Manifest with name, version, triggers, capabilities
- `knowledge.md` - Domain knowledge

**Optional:**

- `procedures/*.md` - Step-by-step how-to guides

### Agents

Composed bundles of skills for specific contexts.

**Required files:**

- `agent.yaml` - Manifest with skills list, context
- `README.md` - Human-readable description

### Rules

Simple constraints, typically <10 lines. No procedures needed.

**Location:** `rules/{global,domain}/`

### Prompts

Standalone prompts referenced by agents.

**Location:** `prompts/{system,templates}/`

## External Skills

External skills are fetched from upstream repos and not committed to git.

**Manifest:** `external-skills.yaml`

```yaml
skills:
  - name: skill-creator
    source: https://github.com/anthropics/skills.git
    branch: main
    path: skills/skill-creator # Path in source repo
    target: skills/domain/ai/skill-creator # Local path
```

**Syncing:**

- Automatic: Hooks run on `git checkout` and `git pull`
- Manual: `./scripts/sync.sh`

**Setup:** Run `./setup.sh` after cloning to configure hooks and initial sync.

## Validation Rules

### Skill Validation

1. Must have `skill.yaml` with required fields: name, version, description
2. Must have `knowledge.md`
3. If procedures declared, files must exist in `procedures/`
4. Tags should be lowercase, hyphenated

### Agent Validation

1. Must have `agent.yaml` with required fields: name, version, skills
2. Must have `README.md`
3. All referenced skills must exist

### Structure Validation

1. Skills in `skills/core/` or `skills/domain/`
2. Agents in `agents/`
3. Rules in `rules/`
4. Prompts in `prompts/`
5. No orphaned files in skill/agent directories

## Best Practices

### Naming Conventions

- **Skills:** lowercase, hyphenated (e.g., `keeper-commander`)
- **Agents:** lowercase, hyphenated (e.g., `homelab-admin`)
- **Rules:** lowercase, hyphenated (e.g., `net-guidelines.md`)

### When to Create What

| Create | When                                              |
| ------ | ------------------------------------------------- |
| Skill  | Has procedures, substantial knowledge (>10 lines) |
| Rule   | Simple constraint, <10 lines, no procedures       |
| Agent  | Composing skills for specific context             |

### Documentation

- Every skill needs `knowledge.md` with domain expertise
- Procedures should be actionable, step-by-step
- Agents need `README.md` explaining purpose and usage
