# Synthetic collection reference

A collection's `path` names a source repo. `skills_dir` defaults to `skills`.
Each `skills` list item is a directory name, or `{source, name}` for a rename.
Only listed source skills are linked into `~/AI/skills` by `./scripts/sync.sh`.
An existing source directory is not automatically discovered by synchronization.
Collections whose source paths do not exist are skipped.

```yaml
collections:
  private:
    path: ~/Repositories/ai-private
    skills:
      - example
      - source: another-source
        name: another-name
```

Use `links` for non-skill content. Prefer directory links for actively written
configuration so atomic file replacement does not break the directory link.

## Published skills

A collection without `ref` serves whatever branch its checkout has checked out.
To serve merged skills, point a collection at a dedicated detached worktree and
set `ref: origin/main`. Each sync fetches and moves that worktree to `ref`
before linking, and leaves it alone with a warning when it is on a branch, has
local changes, or the fetch fails.
