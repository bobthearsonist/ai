# Skill evals (local, native)

Repository-owned cases for the shared [ai-evals engine](https://github.com/bobthearsonist/ai-evals). The engine is a pinned Git dev dependency; no engine implementation is duplicated here. Currently Claude only, via `claude plugin eval`; Copilot and OpenCode are stubs.

See [docs/local-native-runner.md](docs/local-native-runner.md).

```powershell
npm ci
npm test
node local/cli.mjs preflight
node local/cli.mjs run --suite security --approve-sessions 18
node local/run-all.mjs
```

Run these commands from `evals`. GitHub SSH access is needed to install the private engine. `evals.json` resolves cases, skill roots and outputs relative to this directory; the thin wrappers supply its absolute path, so they also work when invoked from elsewhere. `cli.mjs` preserves the default `git-commit-style` suite. `run-all` prints the required session approval before any live execution.

Suites live in `local/cases/<skill>/*.json`; fixtures and `.work` artifacts remain here. Tests validate these suites and the installed engine integration; engine tests live in `ai-evals`. Results are labelled `native-authenticated-non-hermetic`. An earlier Docker-based harness was removed; it is preserved in git history at commit `42120c3`.
