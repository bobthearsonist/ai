---
name: ai-repo-management
description: Use when working with the AI toolkit framework or how the private content repo hooks into it — creating, placing, or registering skills/agents/hooks, syncing collections, editing local.yaml or external-skills.yaml, managing the ai-private plugin or bobthearsonist marketplace, the ~/AI sync mechanism, or troubleshooting why a skill won't load or distribute. Triggers on "create skill", "new agent", "ai repo", "ai-private", "sync skills", "add skill", "register skill", "local.yaml", "external-skills", "collections", "plugin", "marketplace", "publish skill", "hook into ai", "distribution pipeline".
---

# AI Repository Management

Manage the AI toolkit at `~/AI/`: where skill sources live, how they are
registered, and how `sync.sh` delivers them to every client. The `~/AI/` repo
owns the machinery; `ai-private` is a content repo that registers as a
collection and also ships as a Claude Code plugin.

## Before you act

Before creating, editing, moving, or registering a skill, agent, or hook, read
`~/AI/docs/skills-agents-architecture.md` › Sync Flow and work only in the place
it names for that source. `~/AI/skills/<name>` is usually a copy or a link, so
an edit made there is lost or lands somewhere you did not intend.

The layout shifts over time. Read the current files rather than trusting memory
or this skill:

| For… | Read |
|------|------|
| Where a source lives and where to edit it | `~/AI/docs/skills-agents-architecture.md` › Sync Flow |
| Which kind of source goes in which registry | `~/AI/README.md` › Repository Model, and the header of `~/AI/external-skills.yaml` |
| Collection fields, item forms, `ref` publication worktrees | `~/AI/docs/collections.md` |
| What is registered now, and which repo is personal or work | `~/AI/local.yaml` (`collections.<name>.path`), `~/AI/external-skills.yaml` |
| Collection schema template | `~/AI/local.yaml.example` |
| Component types, hooks | `~/AI/docs/skills-agents-architecture.md` › Component Types, Hooks |
| How `ai-private` hooks in, the plugin, hook releases | `~/Repositories/ai-private/README.md`, `~/Repositories/ai-private/docs/PLUGIN.md` |

## Responsibility Boundary

This skill owns source placement, registration, synchronization, and local
client discovery. It does not own how a source repository publishes plugins,
marketplaces, organization bundles, or standalone packages.

Treat these as separate operations:

- **Local discovery**: register sources and run `sync.sh`.
- **Repository publication**: follow the source repository's instructions and
  load its publishing skill when one exists.
- **Standalone export**: create package files only when explicitly requested.

## Creating or Registering a Skill

1. Classify the source with README › Repository Model. A private-access or
   machine-specific source is always a `local.yaml` collection, never an
   `external-skills.yaml` entry.
2. Create `skills/<name>/SKILL.md` in the source repo that `local.yaml` names
   for that collection.
3. Register it by matching existing entries and `local.yaml.example`, not a
   schema recalled from memory.
4. Run `cd ~/AI && ./scripts/sync.sh` and confirm `~/AI/skills/<name>` exists.

## Troubleshooting

**Skill not loading?**
1. Check the entry: `ls -la ~/AI/skills/<name>` shows a link or a copied folder.
2. If it is missing, confirm it is listed in `local.yaml` or `external-skills.yaml`.
3. Run `./scripts/sync.sh` and read its warnings: it names any git skill it could
   not fetch, and any published worktree it skipped.
4. A broken link means the source folder is missing at the configured path.

**Plugin component not appearing?** See `ai-private/docs/PLUGIN.md` — likely the
plugin isn't enabled in `~/.claude/settings.json`, or Claude Code needs a restart.

**Sync failing?**
- `yq` must be installed (sync.sh parses YAML with it)
- On Windows: `MSYS=winsymlinks:nativestrict` is set automatically
- Git-fetched skills need network access on first clone

## Quick Validation

```bash
cd ~/AI

# Sync everything
./scripts/sync.sh

# Find broken symlinks
find skills/ -maxdepth 1 -type l ! -exec test -e {} \; -print

# List what is registered right now (the live source of truth)
echo "=== external-skills.yaml ===" && yq '.skills[].name' external-skills.yaml
echo "=== local.yaml collections ===" && yq '.collections[].skills[]' local.yaml
```
