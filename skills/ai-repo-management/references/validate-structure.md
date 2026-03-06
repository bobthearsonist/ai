# Validate AI Repository Structure

Verify integrity of the AI repository. Use skill-creator for creating new skills.

## When to Use

- Before committing structure changes
- When experiencing broken references
- Periodic maintenance check

## Quick Validation

```bash
cd ~/AI

# Check external skills are synced
./scripts/sync.sh

# Verify agent skill references exist
for agent in agents/*/agent.yaml; do
  yq '.skills[]' "$agent" 2>/dev/null | while read -r skill; do
    [ -d "skills/core/$skill" ] || [ -d "skills/domain/$skill" ] || echo "Missing: $skill"
  done
done
```

## Structure Report

```bash
echo "Skills: $(ls -d skills/{core,domain}/*/ 2>/dev/null | wc -l)"
echo "Agents: $(ls -d agents/*/ 2>/dev/null | wc -l)"
echo "Rules: $(find components/rules -name '*.md' 2>/dev/null | wc -l)"
```

## Common Issues

| Issue                          | Fix                                               |
| ------------------------------ | ------------------------------------------------- |
| External skill missing         | Run `./scripts/sync.sh`           |
| Agent references missing skill | Create skill with skill-creator or fix agent.yaml |
| Broken workspace reference     | Update .code-workspace path                       |
