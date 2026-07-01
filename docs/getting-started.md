# Getting Started

Use this path when you want this repo to become the central place that gathers skills, agents, rules, and prompts from multiple source repos.

## Prerequisites

| Tool | Why it is needed | Install example |
| --- | --- | --- |
| Git | Clone this repo and git-backed skills | `xcode-select --install` or your package manager |
| `yq` v4 by Mike Farah | Parse `external-skills.yaml` and `local.yaml` | `brew install yq` |

`scripts/sync.sh` uses `yq e ...` syntax. The Python package named `yq` is not compatible with this repo's scripts.

## Install

```bash
git clone git@github.com:bobthearsonist/ai.git ~/AI
cd ~/AI
./setup.sh
```

`setup.sh` checks prerequisites, enables repo git hooks, and runs the first sync. The sync may fetch git-backed skills from `external-skills.yaml`.

If you only want to review the repo before fetching external skills:

```bash
./setup.sh --skip-sync
```

## Add Your Local Skills

`setup.sh` creates `local.yaml` from the template when it is missing. If you skipped setup or need to recreate it, copy the template:

```bash
cp local.yaml.example local.yaml
```

Edit the first collection so it points at the repo that contains your skills:

```yaml
collections:
  personal:
    path: ~/Repositories/my-ai-skills
    skills:
      - code-review
      - release-notes
```

The default layout is:

```text
~/Repositories/my-ai-skills/
└── skills/
    ├── code-review/
    │   └── SKILL.md
    └── release-notes/
        └── SKILL.md
```

Then sync:

```bash
./scripts/sync.sh
```

## Connect Your AI Client

The sync script only creates `~/AI/skills/*` and `~/AI/agents/*`. Your AI client still needs to read those paths.

For GitHub Copilot in VS Code, add user settings like:

```json
{
  "chat.useAgentsMdFile": true,
  "chat.useAgentSkills": true,
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

For terminal Copilot CLI setup, see [GitHub Copilot CLI](copilot-cli.md).

For Claude Code on macOS:

```bash
mkdir -p ~/.claude
ln -sfn ~/AI/AGENTS.md ~/.claude/CLAUDE.md
ln -sfn ~/AI/skills ~/.claude/skills
ln -sfn ~/AI/agents ~/.claude/agents
```

For OpenCode, point its config at the shared files or use the Claude-compatible skill paths it already discovers. See [Client support](client-support.md) for more options and Windows examples.

## Verify

Run:

```bash
./scripts/doctor.sh
```

Then open your AI client and ask it to list available skills. If a skill does not appear, check:

1. The source skill has `SKILL.md` with valid `name` and `description` frontmatter.
2. `./scripts/sync.sh` linked it under `~/AI/skills/<name>`.
3. Your client is configured to read `~/AI/skills`.
4. You restarted or reloaded the client after changing skill paths.

## Updating Later

Run this whenever you add or rename skills in a collection:

```bash
cd ~/AI
./scripts/sync.sh
./scripts/doctor.sh
```

After `./setup.sh`, this repo also syncs after git checkout and git pull/merge through `.githooks/`.
