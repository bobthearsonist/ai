# Contributing

Thanks for improving the AI toolkit. Keep contributions focused on source files and repeatable setup so other people can reuse the work on their machines.

## Before You Change Files

1. Decide whether the content belongs in this repo, a personal/work collection, or a project repo.
2. Update source-of-truth files, not synced output.
3. Keep private company, customer, credential, and machine-specific details out of tracked files.

## Where Contributions Belong

- **Broad reusable toolkit skill:** `skills/<name>/SKILL.md`, registered in `external-skills.yaml` as `type: internal`.
- **Third-party git-backed skill:** `external-skills.yaml` as `type: git`.
- **Personal/work skill:** your own repo, exposed through `local.yaml`.
- **Project-specific skill:** the project repo under `.github/skills/` or `.claude/skills/`.
- **Short rule:** `rules/`.
- **Reusable prompt text:** `prompts/`.
- **Setup or sync behavior:** `scripts/`, `setup.sh`, or docs.

`skills/` and `agents/` are gitignored because most entries are synced. Use `git add -f` only for intentional internal repo skills or agents.

## Skill Checklist

Before opening a PR for a skill:

- `SKILL.md` has `name` and `description` frontmatter.
- The description says when to use the skill, not just what it is.
- The body gives concrete steps, examples, or decision rules.
- Supporting files are referenced only when they are needed.
- The skill does not contain secrets, tokens, customer data, or local-only paths.
- The skill name is stable and unlikely to collide with a personal/work skill.

For deeper skill design guidance, use the existing `skill-creator`, `skill-design`, and `ai-repo-management` skills as the source of truth.

## Validation

Run:

```bash
./scripts/sync.sh
./scripts/doctor.sh
```

If you changed shell scripts, run a syntax check:

```bash
bash -n setup.sh scripts/sync.sh scripts/doctor.sh
```

If you changed docs only, read the rendered Markdown and verify links point at existing files.

## PR Expectations

Keep PRs small enough to review. Include:

- What workflow the change improves.
- Any new setup or migration step.
- Validation you ran.
- Any known client-specific limitations.
