# Plugins

Some source repos ship as Claude-format plugins: a `.claude-plugin/plugin.json`
with `skills/`, `agents/`, `commands/` and `hooks/` that install together.
Claude Code and GitHub Copilot CLI both load this format, hooks included.
Skills and agents can reach those clients only through a plugin or through
this repo's sync; hooks and commands only through a plugin.

This repo decides, per machine, **which copy** of each plugin those clients
load, and keeps the clients from loading a plugin's skills twice.

## Dev and published copies

| Mode | Loads | Edits reach a client | Use on |
|---|---|---|---|
| `dev` | your working copy, in place, from a local marketplace | next session, or `/reload-plugins` in Claude Code; no commit, version bump or publish | the machine where you develop the plugin |
| `published` | the copy in the plugin's own marketplace | after you publish and run the client's `plugin update` | every other machine |

Both modes use the same plugin name, so a skill keeps its name
(`ai-private:obsidian-notes`) whichever copy is loaded. Both clients let a
plugin shadow a same-named one, so only one copy may be enabled at a time.

## Configure

In `local.yaml` (see `local.yaml.example`):

```yaml
dev_marketplace:
  name: local
  root: ~/Repositories        # must contain each dev plugin's folder

plugins:
  ai-private:
    mode: dev                 # dev | published
    path: ai-private          # working copy, relative to root
    marketplace: bobthearsonist
  obsidian:
    mode: published
    marketplace: obsidian-skills
    marketplace_source: obsidianmd/obsidian-skills   # added when not registered
```

`root` must be a real parent folder of the plugin folders. Both clients skip
symlinks that point outside a local marketplace, so a folder of links to your
repos does not work.

Then apply it:

```bash
./scripts/plugins.sh --dry-run   # show what would change
./scripts/plugins.sh
```

`plugins.sh`:

1. Writes `<root>/.claude-plugin/marketplace.json` listing every plugin that has
   a `path`. It refuses to overwrite a `marketplace.json` it did not write.
2. For Claude Code and Copilot CLI, registers any missing marketplace, installs
   or enables the chosen copy (Claude Code at user scope), and disables every
   other copy of the same plugin, in every Claude Code scope.
3. When Claude Code installs a copy for the first time, carries over the plugin
   options set on the other copy, because options are stored per plugin id
   (`name@marketplace`). Sensitive options are not copied.

It only acts on differences, so re-running it is safe. Run `./scripts/doctor.sh`
to check the result: it fails when a client enables two copies of one plugin.

## Keep skills from loading twice

A client that loads a plugin and also reads a skill folder containing the same
skills lists each one twice: Claude Code shows `obsidian-notes` and
`ai-private:obsidian-notes`; Copilot CLI keeps the first it finds. To prevent
that, `sync.sh` builds two views next to `skills/` and `agents/`:

| Folder | Contains | Read by |
|---|---|---|
| `skills/`, `agents/` | everything | clients without plugin support (OpenCode) |
| `skills-without-plugins/`, `agents-without-plugins/` | everything except items a configured plugin delivers | Claude Code, Copilot CLI |

An item counts as plugin-delivered when its source names a plugin that is
listed under `plugins:` on this machine:

- a `local.yaml` collection with `plugin: <name>`, for all its skills and agents
- an `external-skills.yaml` entry with `plugin: <name>`

A machine that does not configure the plugin keeps those items in the views.

Client wiring:

```bash
ln -sfn ~/AI/skills-without-plugins ~/.claude/skills
ln -sfn ~/AI/agents-without-plugins ~/.claude/agents
ln -sfn ~/AI/skills-without-plugins ~/.copilot/skills
ln -sfn ~/AI/skills ~/.config/opencode/skills
```

OpenCode also reads `~/.claude/skills`. Its own `~/.config/opencode/skills` is
registered later, and a later source replaces an earlier skill with the same
ID, so it sees each skill once.

## Publish

Publishing belongs to the plugin's own repo; for `ai-private` see its
`docs/PLUGIN.md`. A published copy updates only when its version changes, so
bump the version, push, and run `claude plugin update <name>@<marketplace>` or
`copilot plugin update <name>@<marketplace>` on the other machines.

## Gotchas

- Claude Code records a cached copy when it installs a dev plugin, but loads the
  working folder. To see which folder a session loaded, run
  `claude -p --output-format stream-json --verbose` and read `plugins[].path` in
  its init event.
- Uninstalling a dev plugin from Copilot CLI only disables it and leaves
  `"<name>@<marketplace>": false` in `~/.copilot/settings.json`.
- In a hook entry, Copilot CLI on Windows runs a `powershell` key instead of
  `command` when both are present. Keep one `command` per hook; Copilot runs a
  `bash "${CLAUDE_PLUGIN_ROOT}/..."` command through Git Bash.
- Copilot CLI accepts agents as both `*.md` and `*.agent.md` and names them
  `<plugin>:<agent>`.
- VS Code can load a plugin folder through the experimental
  `chat.pluginLocations` setting; this repo does not manage that yet.
