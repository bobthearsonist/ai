# Synthetic architecture reference

Canonical personal skills live in the private source repository's `skills/`.
Work skills live in a separate work source repository.
The framework's shared `skills/` and `agents/` are generated discovery outputs.
Collections supply local content; external-skills lists internal and Git sources.
Instructions, skills, agents, and permissions are shared client surfaces.
Claude plugin publication and hooks are separate from local collection discovery.

## Sync Flow

| Source | Registered in | Lands in `skills/<name>` as | Edit it in | Editing `skills/<name>` instead |
| --- | --- | --- | --- | --- |
| Internal toolkit skill | `external-skills.yaml`, `type: internal` | the tracked source | `skills/<name>` itself | is the right place |
| Public git skill | `external-skills.yaml`, `type: git` | a copy from `.external-cache` | the upstream repo | is overwritten by the next sync |
| Collection skill | a `local.yaml` collection | a symlink into that checkout | the checkout | edits the checkout through the link |
| Published collection skill | a `local.yaml` collection with `ref` | a symlink into a detached worktree | your working clone, then merge to `ref` | leaves local changes that stop sync refreshing the worktree |

`external-skills.yaml` is shared and public, so private-access or machine-specific
sources must be `local.yaml` collections.
