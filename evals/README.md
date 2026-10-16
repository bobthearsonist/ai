# Skill evals (local, native)

Evaluates skills with the clients' own tooling on the machine's existing login. Results are labelled `native-authenticated-non-hermetic`. Currently Claude only, via `claude plugin eval`; Copilot and OpenCode are stubs.

See [docs/local-native-runner.md](docs/local-native-runner.md).

```
npm test
node local/cli.mjs preflight
node local/cli.mjs run --suite security --approve-sessions 18
```

Suites live in `local/cases/<skill>/*.json`. An earlier Docker-based harness was removed; it is preserved in git history at commit `42120c3`.
