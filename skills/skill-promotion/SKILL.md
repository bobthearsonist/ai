---
name: skill-promotion
description: Promote validated memory observations into reusable skills. Use when evaluating entities for promotion, creating skills from memory patterns, or understanding skill promotion criteria. Triggers on "promote to skill", "create skill from memory", "skill promotion", "10+ observations", "memory to skill".
---

# Skill Promotion

Convert validated memory observations into reusable skills.

## Promotion Criteria

Promote observations from memory to skills when ALL criteria are met:

1. **Volume**: Entity has **10+ observations**
2. **Procedural**: Observations are step-by-step instructions (not just facts)
3. **Validated**: Pattern has been used/tested multiple times
4. **Stable**: Not actively being debugged or changed
5. **Reusable**: Applies across multiple use cases (not project-specific)

## Where Skills Go

Check `~/ai/local.yaml` for local paths:

| Domain | Location |
|--------|----------|
| Work-specific | `work.skills_path` from local.yaml (external, symlinked) |
| General domain | `~/ai/skills/domain/{skill-name}/` |
| Core/framework | `~/ai/skills/core/{skill-name}/` |

## Promotion Workflow

### 1. Evaluate Candidates

After reading memory, identify entities meeting criteria:

> "Entity `{name}` has {count} observations and appears ready for skill promotion. Should I convert it to a skill now?"

### 2. Cluster Related Observations

Group observations that describe the same procedure:
- Look for repeated entity names
- Identify observations referencing same component/feature
- Find observation sequences describing process steps

### 3. Create SKILL.md

Follow the skill-creator skill for structure. Minimum:

```markdown
---
name: {skill-name}
description: {when to use, triggers}
---

# {Skill Title}

{Consolidated procedural content from observations}
```

### 4. Post-Promotion Cleanup

After successful skill creation:
- **Delete promoted observations** from memory to avoid duplication
- Skill becomes the authoritative source
- Future updates go to skill, not memory

## Automatic Triggers

Consider promotion when:
- Completing a complex domain-specific implementation
- User teaches a new workflow or procedure
- User says "remember this", "save this procedure", "create a skill"
- After 3+ sessions working on same domain/pattern
- Memory has 10+ observations on same entity

## Manual Trigger

User explicitly asks:
- "review memory for skills"
- "what can we promote to skills?"
- "create a skill for [X]"
