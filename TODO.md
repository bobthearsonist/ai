# AI Repository TODO

## In-Repo Skills

- [x] `ai-client-config` - AI coding client configuration paths
- [x] `ai-repo-management` - AI repo structure management and validation
- [x] `permissions-yaml` - Unified AI tool permissions management
- [x] `skill-promotion` - Promote memory observations into skills

## In-Repo Agents

- [x] `skill-builder` - Converts memory observations into skills

## Tooling

- [ ] Script to validate skill YAML format
- [ ] Script to generate .clinerules from agent format
- [ ] Script to generate Copilot instructions from agent format
- [ ] Test automation for sync script (see `.worktrees/feature/test-automation/`)

## Collections System

The sync script (`scripts/sync.sh`) supports composing skills and agents from external repos via `local.yaml`. See `local.yaml.example` for configuration.
