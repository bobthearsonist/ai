# Skills and Agents Architecture

This repo keeps reusable AI behavior in small, portable components.

## Component Types

- **Skill:** use when the content has procedures, decision points, or substantial domain knowledge. Source format: directory with `SKILL.md`.
- **Agent:** use when you need a named specialist persona that can load skills or tools. Source format: Markdown file with frontmatter.
- **Rule:** use when the guidance is a short constraint, usually under 10 lines. Source format: plain Markdown.
- **Prompt:** use when you need reusable text that can be copied or referenced. Source format: plain Markdown.

## Skill Sources

- **Internal repo skill:** configured in `external-skills.yaml` with `type: internal`; tracked directly in this repo.
- **Third-party git skill:** configured in `external-skills.yaml` with `type: git`; copied from `.external-cache`.
- **Personal/work skill:** configured in a `local.yaml` collection; symlinked into `skills/`.
- **Project-local skill:** configured in the project repo; read directly by the client.

## Portability Flow

```mermaid
flowchart LR
    subgraph sources["Skill sources"]
        personal["Personal skills repo<br/><code>skills/*/SKILL.md</code>"]
        team["Team/work skills repo"]
        upstream["Shared upstream skills<br/><code>external-skills.yaml</code>"]
        project["Project-local skills<br/><code>.github/skills</code>"]
    end

    subgraph toolkit["~/AI toolkit"]
        config["local.yaml<br/>machine collections"]
        sync["scripts/sync.sh<br/>fetch + symlink"]
        shared["~/AI/skills<br/>shared output"]
    end

    subgraph clients["AI clients"]
        copilot["GitHub Copilot"]
        claude["Claude Code"]
        opencode["OpenCode"]
        others["Other clients"]
    end

    personal -->|"register"| config
    team -->|"register"| config
    upstream -->|"fetch"| sync
    config -->|"read"| sync
    sync -->|"publish"| shared
    shared -->|"load globally"| copilot
    shared -->|"load globally"| claude
    shared -->|"load globally"| opencode
    shared -->|"adapt paths"| others
    project -. "load per repo" .-> copilot
    project -. "load per repo" .-> claude
```

## Directory Layout

```text
~/AI/
├── AGENTS.md
├── external-skills.yaml
├── local.yaml
├── local.yaml.example
├── scripts/
│   ├── sync.sh
│   └── doctor.sh
├── skills/
├── agents/
├── rules/
├── prompts/
└── permissions/
```

`skills/` and `agents/` are mostly sync output and are gitignored. Add shared repo-owned skills with `git add -f` only when they are intentionally internal toolkit skills.

## Sync Flow

Every client reads `skills/`, so what lands there decides where a change must be made:

| Source | Registered in | Lands in `skills/<name>` as | Edit it in | Editing `skills/<name>` instead |
| --- | --- | --- | --- | --- |
| Internal toolkit skill | `external-skills.yaml`, `type: internal` | the tracked source | `skills/<name>` itself | is the right place |
| Public git skill | `external-skills.yaml`, `type: git` | a copy from `.external-cache` | the upstream repo | is overwritten by the next sync |
| Collection skill | a `local.yaml` collection | a symlink into that checkout | the checkout | edits the checkout through the link |
| Published collection skill | a `local.yaml` collection with `ref` | a symlink into a detached worktree | your working clone, then merge to `ref` | leaves local changes that stop sync refreshing the worktree |

`external-skills.yaml` is shared and public, so private-access or machine-specific sources must be `local.yaml` collections. A git skill that fails to fetch keeps its previous copy, and `sync.sh` exits non-zero after finishing the rest.

`scripts/sync.sh` does not configure AI clients. It only prepares this repo's shared paths. See [Client support](client-support.md) for client wiring.

For skill design and quality guidance, use the `skill-creator`, `skill-design`, and `ai-repo-management` skills as the source of truth.

## Hooks

Hooks run only in Claude Code and ship through the `ai-private` plugin cache, not `sync.sh`. A hook change needs that repo's release loop in `docs/PLUGIN.md`, including the version bump. The `hooks:` key in `local.yaml` still links files into `~/AI/hooks/`, but no client reads that folder.

## Agent Format

Top-level agents use a small frontmatter surface for broad client compatibility:

```yaml
---
name: skill-builder
description: Converts memory observations into reusable skills.
---
```

Client-specific agent formats can live under subdirectories when needed.
