---
name: ai-repo-management
description: AI repository structure management and validation. Use when creating skills or agents, organizing AI skills/agents/rules/prompts in ~/AI/, validating repository structure, syncing external skills, checking manifest integrity, editing external-skills.yaml, or understanding the AI component architecture. Triggers on patterns like "create skill", "new agent", "ai repo", "validate skill", "check structure", "external-skills", "sync skills".
---

# AI Repository Management

Manage and validate the AI repository structure at `~/AI/`.

## MANDATORY: Creating a New Skill

When creating a skill in the **work skills directory** (from `local.yaml`), you MUST:

1. **Create the skill** in the work skills path (e.g., `{{work.skills_path}}/my-skill/SKILL.md`)
2. **Add entry to external-skills.yaml** with the new skill:
   ```yaml
   - name: work-my-skill
     type: symlink
     description: Brief description of the skill
     source: "{{work.skills_path}}/my-skill"
     target: skills/work-my-skill
   ```
3. **Run sync** to create symlink: `./scripts/sync.sh`

**Failure to add to external-skills.yaml means the skill won't be available via the pipeline.**

For skills in `~/AI/skills/` directly, no manifest entry is needed.

## Capabilities

- Validate AI repository structure
- Check skill and agent manifest integrity
- Verify documentation consistency
- Generate structure reports

## Repository Structure

```
~/AI/
├── skills/                     # Active capabilities with procedures
│   ├── core/                   # Framework skills
│   └── domain/                 # Domain-specific skills
├── agents/                     # Composed skill bundles
├── rules/                      # Simple constraints (<10 lines)
├── prompts/                    # Standalone prompts
├── external-skills.yaml        # External skill manifest
├── local.yaml                  # Machine-specific config (gitignored)
└── scripts/sync.sh
```

## Component Types

| Type   | When to Create                                    |
|--------|---------------------------------------------------|
| Skill  | Has procedures, substantial knowledge (>10 lines) |
| Rule   | Simple constraint, <10 lines, no procedures       |
| Agent  | Composing skills for specific context             |

## Quick Validation

```bash
cd ~/AI

# Sync external skills
./scripts/sync.sh

# Verify agent skill references exist
for agent in agents/*/agent.yaml; do
  yq '.skills[]' "$agent" 2>/dev/null | while read -r skill; do
    [ -d "skills/core/$skill" ] || [ -d "skills/domain/$skill" ] || echo "Missing: $skill"
  done
done
```

## References

- [Repository structure and validation](references/structure.md) - Full structure details and validation procedures
