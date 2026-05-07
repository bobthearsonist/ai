# Collections Reference

Collections let this repo compose skills, agents, hooks, and related config from local source repos without committing machine-specific paths.

`local.yaml` is gitignored. Copy `local.yaml.example` and edit it for each machine.

## Minimal Collection

```yaml
collections:
  personal:
    path: ~/Repositories/my-ai-skills
    skills:
      - code-review
      - release-notes
```

This links:

```text
~/AI/skills/code-review -> ~/Repositories/my-ai-skills/skills/code-review
~/AI/skills/release-notes -> ~/Repositories/my-ai-skills/skills/release-notes
```

## Collection Fields

| Field | Default | Purpose |
| --- | --- | --- |
| `path` | required | Source repo or directory for the collection |
| `skills_dir` | `skills` | Directory under `path` that contains skills |
| `agents_dir` | `agents` | Directory under `path` that contains agents |
| `hooks_dir` | `hooks` | Directory under `path` that contains hooks |
| `skills` | empty | Skill directories to link into `~/AI/skills` |
| `agents` | empty | Agent files/directories to link into `~/AI/agents` |
| `hooks` | empty | Hook files/directories to link into `~/AI/hooks` |
| `links` | empty | Other root-level links to expose from the collection |

Collections whose `path` does not exist are skipped. This lets the same `local.yaml` work on personal and work machines if only some source repos are available.

## Item Forms

String form:

```yaml
skills:
  - code-review
```

Object form with rename:

```yaml
skills:
  - source: reviewer
    name: code-review
```

Object form with external target:

```yaml
links:
  - source: claude/statusline.sh
    target: ~/.claude/statusline.sh
```

`target` paths support `~` expansion.

## Layout Examples

Default `skills/` directory:

```yaml
collections:
  personal:
    path: ~/Repositories/my-ai-skills
    skills:
      - code-review
```

Flat skill repo:

```yaml
collections:
  personal-flat:
    path: ~/Repositories/my-flat-skills
    skills_dir: ""
    skills:
      - code-review
```

Work repo with renamed public skills:

```yaml
collections:
  work:
    path: ~/Repositories/company-ai
    skills:
      - source: dotnet
        name: company-dotnet
      - source: incident-response
        name: company-incident-response
    agents:
      - company-agent.md
```

Expose a whole config directory:

```yaml
collections:
  private:
    path: ~/Repositories/ai-private
    links:
      - claude
```

Prefer directory links for application-written config. File symlinks can be replaced by apps that write through an atomic temp-file rename.
