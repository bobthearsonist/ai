# Handoff — consolidate hook documentation

Staged, deliberately uncommitted. Picked up in a session focused on documentation
consolidation. Written 2026-09-03.

## The task

`skills/ai-repo-management/SKILL.md` gained a 38-line section `## Hooks (Claude Code only)`
on 2026-09-02 (commit `bbd4cfb`). It **duplicates** a subset of
`../ai-private/docs/PLUGIN.md`. Replace the duplicated release-loop content with a
pointer, keeping only what is genuinely ai-repo-management's own concern.

## Why this is a duplication, not new documentation

`ai-private/docs/PLUGIN.md` (111 lines) has documented the same release loop since
**2026-06-03**, commit `ce272ed docs(plugin): document the release loop + cache-frozen
gotcha`. It is *more* complete than the copy:

```
2. Bump `version` in plugin.json
3. git push origin main — the marketplace pulls from GitHub
4. claude plugin update ai-private@bobthearsonist
5. claude plugin tag . then git push origin --tags     <- the copy OMITS this
6. Restart Claude Code
```

PLUGIN.md line 38 also already states the fact a five-agent audit spent 27 minutes
rediscovering on 2026-09-02:

> hooks and `commands/` are delivered only through the plugin cache — so any hook/command
> change requires the full release loop + restart, not just a sync.

The two copies **already disagree** one day after the copy was written: PLUGIN.md has
step 5, the skill copy does not. That is the drift this change exists to stop.

`skills/skill-tooling/SKILL.md` states the rule that was violated:

> Repository publication: follow the source repository's instructions and load its
> publishing skill when one exists.

## What to cut and what to keep

**Cut** — belongs to PLUGIN.md, replace with a pointer:
- the numbered release loop
- the detail of how the plugin cache is pinned

**Keep** — these are ai-repo-management's own concerns, not PLUGIN.md's:
- hooks ship via the **plugin**, not via `sync.sh` (the surprising fact; the whole reason
  a reader of this skill needs to be told anything at all)
- `~/AI/hooks/` is **orphaned** — `sync.sh` materializes five symlinks
  (`run-regenerate-visual.sh`, `run-hook.sh`, `post-obsidian-append.md`, `skill-check.sh`,
  `session-start-context.md`) that nothing reads. No Claude Code settings scope references
  that directory; the plugin resolves `${CLAUDE_PLUGIN_ROOT}` to its own cache copy.
  Open question, not yet decided: should the `hooks:` key be dropped from `local.yaml`?
- other clients get **no** hooks — `docs/client-support.md` names four shared surfaces
  (Instructions, Skills, Agents, Permissions) and hooks is not one; opencode's config has
  no `hooks` key; Copilot CLI sets `"disableAllHooks": true`. Git hooks via
  `core.hooksPath` are the only genuinely cross-client hook mechanism.
- the `hooks/` line in the Repository Structure block and the `Hook` row in Component Types
- **one line** on the version-gate trap — a reader must know it exists before deciding
  whether to follow the pointer

Target: 38 lines → roughly 15.

## Unresolved design question

The `ai` repo is intended for public release. `ai-private`'s README says ai-private is
*"kept private so the sibling `ai` repo can be released publicly."* So a skill in the
public repo pointing at `ai-private/docs/PLUGIN.md` is a dangling reference for anyone
outside this machine.

Options not yet weighed:
1. Point generically ("the collection repo's own plugin/release docs") plus the concrete
   local path.
2. Keep enough in the skill that it stands alone for a public reader, and point only for
   the private specifics.
3. Accept the dangling reference — the skill is arguably machine-specific anyway.

An adversarial review of this plan was running when the session ended; if its Part A
findings were captured, fold them in here before deciding.

## Related context worth knowing (measured 2026-09-02/03, do not re-derive)

- **`sync.sh` does not prune strays.** It ran at least three times on 2026-09-03 via
  post-checkout and post-merge hooks; unregistered real directories in `skills/` were
  untouched. It only adds symlinks.
- **The `graphify` skill is a real directory in `skills/`, not a symlink**, written there
  directly by graphify's own installer — which is exactly what ai-repo-management says
  never to do (*"Never create skills directly in `~/AI/skills/`"*). It is in no manifest.
  Vendor installer behaviour colliding with local convention. Low risk: re-running the
  installer restores it.
- **`skills/` is gitignored**, with the comment *"use `git add -f` for shared items"*. A
  bare `git add` on a tracked file under `skills/` is refused. This bit a subagent on
  2026-09-02 and will bite the next person.
- **The meta-pattern.** This is the fourth instance found in one session of documentation
  that was correct but that nothing surfaced at the moment of use: the ten-type entityType
  taxonomy (advisory, drifted 10 → 61 in two weeks), the `rules/global/` tier (instructed
  every session, demonstrably never loaded), `memory-graph-conventions` (accurate but
  unreachable through a broken `search_nodes`), and PLUGIN.md. Adding a fifth copy of a
  fact is not what fixes this class of problem. Pointing, and surfacing at point of use,
  might.

## Also in scope: the installer is broken in worktrees

Separate defect, same deployment path, found 2026-09-03 during a review of the
`.githooks/post-merge` change. Worth fixing in the same session because it is the other
half of "how do machine-local hooks actually get deployed".

`~/.local/bin/git-local-hooks-install.sh` hardcodes `.git/hooks/…` in two places:

```
25:  LOCAL_DIR=".git/hooks/${HOOK_NAME}.d"                    # where it installs
48:  _HOOK_LOCAL_DIR=".git/hooks/$(basename "$0").d"          # the block it generates
```

**In a git worktree, `.git` is a FILE, not a directory** — it contains a `gitdir:` pointer.
So `[ -d ".git/hooks/<event>.d" ]` is false and the dispatcher silently no-ops. Measured:

| Worktree | `.git` | `git rev-parse --git-common-dir` |
|----------|--------|----------------------------------|
| `matching-bug-1` | FILE | `C:/Repositories/matching/.git` |
| `ai-infrastructure-chrome-devtools-gateway` | FILE | `C:/Repositories/ai-infrastructure/.git` |

`[ -d "/c/Repositories/matching-bug-1/.git/hooks/post-merge.d" ]` → **FALSE**.

There are 106 worktrees on this machine, and the block is generated verbatim into all three
hooks (`post-commit`, `post-checkout`, `post-merge`), so the dispatcher is dead in every one
of them for every event.

**Fix direction:** replace the literal `.git` with `$(git rev-parse --git-common-dir)`.
Worktrees share the parent's hooks directory, which is the behaviour already relied on
elsewhere — `core.hooksPath` inheritance through the shared config is what gives 90 of the
106 worktrees their graphify hooks today.

Two caveats before changing it:
- The three already-installed hooks carry the old block inline. Fixing the installer does
  not fix them; they need reinstalling or patching.
- `.githooks/post-merge` was committed on 2026-09-03 (`ace7eaf`) carrying the old form
  deliberately — the review judged the defect pre-existing and out of scope for that diff.
  It should be corrected together with the installer, not separately.

## Files

| Path | Role |
|------|------|
| `skills/ai-repo-management/SKILL.md` | the file to edit; section starts `## Hooks (Claude Code only)` |
| `../ai-private/docs/PLUGIN.md` | the authority being pointed at |
| `skills/skill-tooling/SKILL.md` | states the point-don't-duplicate rule |
| `docs/client-support.md` | the four shared surfaces; hooks absent |
| `local.yaml` | `collections.private.hooks` — the five orphaned entries |
