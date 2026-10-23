# Skill evals (local, ACP)

Repository-owned cases for the shared [ai-evals engine](https://github.com/bobthearsonist/ai-evals). The development dependency installs the sibling `ai-evals` checkout; no engine implementation is duplicated here. Claude and Copilot use only ACP. OpenCode remains unsupported.

See [docs/local-native-runner.md](docs/local-native-runner.md).
The [AI Guild onboarding page](docs/ai-guild-evals.html) explains the workflow,
current evidence and limitations; [Teams draft](docs/ai-guild-teams-blurb.md).

### Local engine dependency

The local `ai-evals` development checkout adds multi-runner selection, Gherkin
authoring, shared v2 assertions, ACP transport and separately opt-in AI judging,
and supports only ACP for both Claude and Copilot. The previous Git pin could
not load these suites. `package.json` now uses `file:../../ai-evals`;
`.npmrc` installs a copy rather than a symlink, and the lockfile includes its
dependencies. Keep the two repositories as siblings. Run `npm ci --ignore-scripts`
in `evals` after changing the engine checkout to refresh the installed copy.
The engine changes remain local and unpublished; a standalone clone needs the
matching sibling checkout. An immutable remote pin is a later publication step,
not an invented reference to an unpushed commit.

Native profiles use temporary homes, read-only tool lists, empty ambient MCP
configuration and a controlled workspace containing the selected skill only
in the with-skill arm. Claude refuses machine-managed settings; version or model
mismatches fail before prompting. Live native ACP acceptance is still pending.
Native/plugin-eval/SDK
execution and replay implementations have been deleted, with no transport
selector or fallback. Validation and dry-run planning
remain available without a live runtime.
For example, with both repositories under `C:\Repositories`:

```powershell
Set-Location C:\Repositories\ai\evals
npm ci --ignore-scripts
npm test
node local\cli.mjs validate --suite git-commit-style
node local\cli.mjs run --suite git-commit-style --dry-run
node local\cli.mjs run-all --dry-run
node local\cli.mjs preflight --client claude --model MODEL_ID
```

Historical evidence from the previous adapter paths (not ACP acceptance):
on 2026-10-21 the Claude smoke passed with a score of 1.00 on Claude Code
2.1.306; archived offline regrading matched. A one-arm smoke does not measure
skill lift. On 2026-10-22 one Copilot SDK smoke using `gpt-6.1-sol` and native
CLI 1.0.102 completed with a valid receipt and captured usage. The staged skill
was invoked; runtime MCP status explicitly showed `github-mcp-server` disabled,
no MCP tools loaded, and empty pre/post inventories. Offline regrading matched
the live score (0.75). The run is valid but below threshold because the
`header-under-72` check failed; it is not a case-level pass or a measure of
skill lift. This is one local acceptance point, not a launch-ready guarantee
for other builds. A separate earlier CLI-path attempt did show active MCP
tools and remains invalid/unscored. OpenCode remains unimplemented. See the
engine README for runner-specific options and limitations. Those historical
archives remain unchanged but are no longer supported for replay or judging
by the development engine.

### Gherkin suites (unreleased)

All 22 cases across the six repository-owned suites are now authored in
`.feature` files, including the cases committed on `origin/main`.
Case IDs, prompts, activation expectations, fixture use and existing offline
samples are preserved. The 19 cases outside `git-commit-style` retain their
exact regex checks and flags; the latter's intentional policy changes are
listed below.
The per-case `*.samples.json` files hold offline pass/fail examples; samples are never sent
to the model. Cases that previously had no samples now have discriminating
pass/fail examples. These JSON files are sample data, not test definitions.
Legacy JSON loading remains an engine compatibility feature, not the
authoring format for this repository.

| Previous policy | Pilot policy |
|---|---|
| `conventional-header` regex | Explicit allowed commit types and a separate lowercase-description check |
| `header-under-72` regex, which actually limited the suffix to 50 characters | Extract one unambiguous subject and require the **whole subject** to be shorter than 72 Unicode code points |
| `breaking-marker` regex | Same regex, including its acceptance of `BREAKING CHANGE` in the body |
| `no-commit-header` negative control | Same regex and prompt |

The extraction/length changes are intentional policy corrections, not a
behavior-preserving syntax conversion. Old run scores stay unchanged.
Recorded-policy replay uses an ACP run's snapshot; applying this pilot to
an ACP archive requires explicit `--policy current --suite git-commit-style`
and writes a separate assessment. Native archives are no longer supported.

Earlier read-only comparisons of the existing `explicit-positive` captures reproduced
the original full scores, including skill-trigger and canary checks:

| Archived answer | Original policy | Pilot policy |
|---|---:|---:|
| Claude, 2026-10-21 14:26 UTC | 1.00 | 0.40 |
| Copilot, 2026-10-22 11:50 UTC | 0.75 | 1.00 |

Claude supplied multiple fenced alternatives, which now fail the three
subject checks rather than becoming invalid evidence. Copilot's subject
passes the corrected whole-subject length limit. These are the **same
captured answers under different policies**, not new model runs, measured
skill changes or overwritten historical scores. The pilot also separates
lowercase validation into its own check, changing check weighting.

The installed local dependency parses these Gherkin suites. No remote branch,
tag, release or published package was changed.

AI judging is a separate `judge` command with an explicit runtime, model,
rubric and exact session approval. It never contributes to deterministic
scores. Both clients use only ACP and refuse native runtimes whose
required isolation cannot be established. Transport success alone is not
evidence of skill/MCP isolation.

### Semantic judge adoption (advisory)

`judge-rubrics.json` assigns meaning-based criteria to nine positive cases:
repository-change delivery, responsibility-based decomposition, both
complexity assessments, both pattern-adoption decisions, and the three
security-advice cases. Exact commit syntax, identifiers, negative controls,
skill activation and disclosure patterns remain deterministic. Existing
regex proxies are retained for historical comparison, **not treated as a
semantic verdict**. Advisory judgements do not replace or change those scores.

Selection was informed by the 2026-10-21 `profisee-sonar` investigation,
recorded in `profisee-ai/evals/TODO.md`: correct answers failed on paraphrases
such as "shouldn't postpone" versus "don't block", "quietly" versus "silent",
and reasons outside a 150-character window. The rubrics accept equivalent
reasoning throughout the answer rather than expanding patterns to fit saved
outputs. The Sonar suite itself is outside this change; no third repository
or frozen baseline was edited. Rubrics are authored criteria, not measured
judge accuracy, and existing regex samples are not semantic calibration data.

For an ACP archive from one of these suites, plan eligible assessments without
inference (replace `<run>` and `MODEL_ID`):

```powershell
node C:\Repositories\ai-evals\local\cli.mjs judge C:\Repositories\ai\evals\.work\local-runs\<run> --client claude --model MODEL_ID --rubric C:\Repositories\ai\evals\judge-rubrics.json --dry-run
```

The JSON map selects matching case IDs; unmapped answers are explicitly
skipped. On 2026-10-23, one candidate smoke and one Claude `haiku` judge
session ran for each of the nine mapped cases. All nine candidate receipts
were valid; the one-run deterministic smoke status was `passed` for four and
`below_threshold` for five. The advisory judge returned eight `pass` and one
`fail` (`command-review`): the candidate discussed shell-history/process-list
exposure but misread the displayed `******` as a possible `abc123` token
instead of recognizing it was masked. All nine assessments passed strict
schema and exact-quote validation, and were stored separately with input and
rubric hashes; no retries were used. The fail is preserved as a finding, not
converted into a pass or used to alter deterministic scores.

This bounded run verifies the exercised Claude/Haiku archive-to-judge path,
not judge accuracy, calibration, general skill quality, or cross-provider
equivalence. The built-in judge profile is Claude-only; unsupported runtimes
and active machine-managed policy fail closed.

### Installed dependency

```powershell
npm ci --ignore-scripts
npm test
node local/cli.mjs preflight --client claude --model MODEL_ID
node local/cli.mjs run --suite security --model MODEL_ID --dry-run
node local/run-all.mjs
```

Run these commands from `evals` with the sibling engine checkout present. `evals.json` resolves cases, skill roots and outputs relative to this directory; the thin wrappers supply its absolute path, so they also work when invoked from elsewhere. `cli.mjs` preserves the default `git-commit-style` suite. `run-all` prints the required session approval before any live execution. Preflight checks existing credentials without inference or login; it does not prove provider access. A live run requires a separately approved explicit model and exact session count.

Suites live in `local/cases/<skill>/*.feature`, with offline samples in
`*.samples.json`; fixtures and `.work` artifacts remain here. Tests validate
all 22 case IDs, require Gherkin definitions and check every offline sample
against the selected engine. Engine tests live in `ai-evals`.
Current results are labelled `acp-non-hermetic`; historical native results are
unchanged and are not replayed by the development engine.
An earlier Docker-based harness was removed; it is preserved in git history
at commit `42120c3`.
