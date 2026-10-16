# Local native eval runner

Runs skill evals with the machine's existing client login (no API tokens). Results are labelled `native-authenticated-non-hermetic`. The Docker harness in `harness/` is separate and deferred.

```
node local/cli.mjs preflight
node local/cli.mjs smoke --approve-sessions 1
node local/cli.mjs run   --approve-sessions 18   # 3 cases x 3 runs x 2 arms
```

- `contract.mjs`: client-neutral runner interface, result schema, registry. New clients implement `preflight`, `plannedSessions`, `run` and declare `capabilities` (never hermetic).
- `compile-claude.mjs`: compiles `cases/<suite>/*.json` into a temp plugin (skill copied byte-for-byte, hash recorded).
- `claude-plugin-eval.mjs`: adapter over `claude plugin eval` (serial, `--no-publish`, `--max-cost-usd`, tools limited to `Skill`).
- `stubs.mjs`: Copilot/OpenCode placeholders with documented requirements.
- Runs refuse to start without `--approve-sessions N` >= planned live sessions.
- Output: `.work/local-runs/<ts>-<cmd>/` (`normalized.json`, `eval-output/report.html`).
- Cost is a list-price estimate; the real guard is the fixed session count.
