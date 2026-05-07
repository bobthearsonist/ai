# Migration Guide

Use this guide when you already have custom skills on your machine and want to move to a shareable repo-based workflow.

## Target End State

```text
~/Repositories/my-ai-skills/
└── skills/
    └── my-skill/
        └── SKILL.md

~/AI/local.yaml
└── collections.personal.path = ~/Repositories/my-ai-skills

~/AI/skills/my-skill -> ~/Repositories/my-ai-skills/skills/my-skill
```

Your AI client should read `~/AI/skills`, not the original scattered local skill directories.

## 1. Inventory Existing Skills

Common places to check:

| Client | Common local path |
| --- | --- |
| GitHub Copilot | `~/.copilot/skills` |
| Claude Code | `~/.claude/skills` |
| OpenCode | `~/.config/opencode/skill` |
| Project repos | `.github/skills`, `.claude/skills`, `.opencode/skill` |

For each skill, confirm it has:

```text
<skill-name>/
└── SKILL.md
```

`SKILL.md` should have frontmatter with at least:

```yaml
---
name: skill-name
description: What this skill does and when to use it.
---
```

## 2. Choose Where Each Skill Belongs

| Skill kind | Recommended source of truth | How to expose it |
| --- | --- | --- |
| Personal reusable skill | Your private AI skills repo | `local.yaml` collection |
| Team/work skill | Team skills repo | `local.yaml` collection or PR to team repo |
| Project-specific skill | The project repo | `.github/skills/<name>` or `.claude/skills/<name>` |
| Generally useful toolkit skill | This repo | PR as an internal skill |
| Third-party skill | Upstream git repo | `external-skills.yaml` |

Do not make `~/AI/skills` the source of truth for personal skills. It is sync output and is gitignored.

## 3. Move Skills Into a Source Repo

Example personal repo:

```text
~/Repositories/my-ai-skills/
├── README.md
└── skills/
    ├── code-review/
    │   └── SKILL.md
    └── release-notes/
        └── SKILL.md
```

Copy or move your existing skill directories into that `skills/` folder. Commit them in the source repo so the skills can be shared or restored on another machine.

## 4. Register the Repo in `local.yaml`

Create local config if needed:

```bash
cd ~/AI
cp local.yaml.example local.yaml
```

Minimal collection:

```yaml
collections:
  personal:
    path: ~/Repositories/my-ai-skills
    skills:
      - code-review
      - release-notes
```

If the source directory and public skill name differ:

```yaml
collections:
  personal:
    path: ~/Repositories/my-ai-skills
    skills:
      - source: reviewer
        name: code-review
```

If your skills are already at the repo root instead of `skills/`:

```yaml
collections:
  personal:
    path: ~/Repositories/my-flat-skills
    skills_dir: ""
    skills:
      - code-review
```

See [Collections reference](collections.md) for the full schema.

## 5. Sync and Verify

```bash
cd ~/AI
./scripts/sync.sh
./scripts/doctor.sh
```

Expected output includes symlinks such as:

```text
skills/code-review -> /Users/you/Repositories/my-ai-skills/skills/code-review
```

If `doctor.sh` reports broken symlinks, check that the collection `path` and skill names match the real source directories.

## 6. Replace Old Client Skill Folders Safely

If a client already has a real local skill directory, decide whether to keep it as source or replace it with the synced path.

Safe migration pattern:

```bash
mv ~/.claude/skills ~/.claude/skills.before-ai-repo
ln -sfn ~/AI/skills ~/.claude/skills
```

Do not delete the backup until the client shows the expected skills. The sync script refuses to overwrite real files or directories for external targets, so messages like this mean you need to move the old path first:

```text
exists and is not a symlink - skipping
```

## 7. Share Skills in Your Own Repos

For a skill that should travel with a project, commit it directly to that project:

```text
my-project/
└── .github/
    └── skills/
        └── project-release/
            └── SKILL.md
```

Use project-local skills for repo-specific workflows, domain language, release steps, or commands that should not be global.

## 8. Promote Skills Back to This Toolkit

Open a PR to this repo when a skill is:

- Useful across more than one project or machine.
- Free of private company/customer details.
- Focused enough to trigger reliably from its `description`.
- Documented with clear steps and validation guidance.

See [Contributing](../CONTRIBUTING.md) before moving a personal skill into this repo.
