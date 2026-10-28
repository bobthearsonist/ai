# Skill evals (local, ACP)

Repository-owned cases for the shared [ai-evals engine](https://github.com/bobthearsonist/ai-evals). The development dependency pins the engine by commit; no engine implementation is duplicated here. Claude and Copilot use only ACP. OpenCode remains unsupported.

See [repository evaluation notes](../docs/skill-evaluations.md).
The [AI Guild onboarding page](docs/ai-guild-evals.html) explains the workflow,
current evidence and limitations; [Teams draft](docs/ai-guild-teams-blurb.md).

### Engine dependency

The current engine pin is `e95e99a24a7f3b7d9d73e8674c9cade995144f84`.
It provides shared semantic assertion-table actions, aggregate 50/50 scoring
and direct suite judge scoring; no engine implementation is duplicated here.

`package.json` pins `@bobthearsonist/ai-evals` to a commit on the engine's
repository, which provides multi-runner selection, Gherkin authoring, shared v2
assertions, ACP transport and separately approved AI judging. To pick up a newer
engine, update the commit in `package.json` and run `npm install`. To test
unreleased engine changes, temporarily point it at a local checkout
(`file:../../ai-evals`) and restore the pin before committing.

Native profiles use temporary homes, read-only tool lists, empty ambient MCP
configuration and a controlled workspace containing the selected skill only
in the with-skill arm. Claude refuses machine-managed settings; version or model
mismatches fail before prompting. Bounded Claude ACP candidate and judge
smokes have completed (see below); cross-client live acceptance remains pending.
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

### Gherkin suites

All 22 cases across the six repository-owned suites are authored in `.feature`
files. Features compile to the engine's schema-v2 policy contract.
The per-case `*.samples.json` files hold offline pass/fail examples; samples are never sent
to the model. Cases that previously had no samples now have discriminating
pass/fail examples. These JSON files are sample data, not test definitions.
JSON case definitions and schema-v1 case compatibility have been removed.
JSON config, sample sidecars and ACP archive formats remain supported.

| Former policy | Current policy |
|---|---|
| `conventional-header` regex | Explicit allowed commit types and a separate lowercase-description check |
| `header-under-72` regex, which actually limited the suffix to 50 characters | Extract one unambiguous subject and require the **whole subject** to be shorter than 72 Unicode code points |
| `breaking-marker` regex | Same regex, including its acceptance of `BREAKING CHANGE` in the body |
| `no-commit-header` negative control | Same regex and prompt |

The extraction/length changes are intentional policy corrections, not a
behavior-preserving syntax conversion.
Recorded-policy replay uses an ACP run's snapshot; applying current policy to
an ACP archive requires explicit `--policy current --suite git-commit-style`
and writes a separate assessment. Native archives are no longer supported.

Multiple fenced alternatives fail the subject checks rather than becoming
invalid execution evidence. Lowercase validation is a separate check,
so compare scores only under the same policy and check weighting.

AI judging is a separate `judge` command with an explicit runtime, model,
recorded Gherkin criteria and exact session approval. It never contributes to deterministic
scores. Both clients use only ACP and refuse native runtimes whose
required isolation cannot be established. Transport success alone is not
evidence of skill/MCP isolation.

### Semantic judge adoption and opt-in scoring

`And the AI judge verifies:` tables use the shared `id`, `action`, and
`expectation` columns to compile each semantic requirement as an independent
criterion across nine positive Gherkin scenarios:
repository-change delivery, responsibility-based decomposition, both
complexity assessments, both pattern-adoption decisions, and the three
security-advice cases. Exact commit syntax, identifiers, negative controls,
skill activation and disclosure patterns remain deterministic. Existing
regex proxies are retained for historical comparison, **not treated as a
semantic verdict**. Semantic judgments contribute to separate combined scores, not deterministic history.
The before/after complexity case retains one freeform criterion for the
composite score: none of the shared action verbs accurately means “uses or
proposes a scoring method.” Its other semantic requirements use the table.

Selection was informed by a prior evaluation investigation: correct answers failed on paraphrases
such as "shouldn't postpone" versus "don't block", "quietly" versus "silent",
and reasons outside a 150-character window. The rubrics accept equivalent
reasoning throughout the answer rather than expanding patterns to fit saved
outputs. Rubrics are authored criteria, not measured
judge accuracy, and existing regex samples do not establish semantic accuracy.

For an ACP archive from one of these suites, plan eligible assessments without
inference (replace `<run>` and `MODEL_ID`):

```powershell
npx --no-install ai-evals judge .work\local-runs\<run> --client claude --model MODEL_ID --dry-run
npx --no-install ai-evals report .work\local-runs\<run> --answer
```

The archived Gherkin policy selects semantic case IDs; other answers are explicitly
skipped. On 2026-10-23, one candidate smoke and one Claude `haiku` judge
session ran for each of the nine mapped cases. All nine candidate receipts
were valid; the one-run deterministic smoke status was `passed` for four and
`below_threshold` for five. The advisory judge returned eight `pass` and one
`fail` (`command-review`). That fail was a rubric defect, not an answer
defect: the prompt contains a literal example bearer token, but the rubric
had been authored from a display that redacted it as asterisks and required
the answer to "recognize the masked value". The rubric now describes the real
prompt; re-judging the same archived answer with it returned `pass`, and the
original assessment was preserved beside the revision during validation.
All nine assessments passed strict schema and exact-quote validation, and
were stored separately with input and rubric hashes; no retries were used.

Per-check regrading of those nine archived answers showed that most
`below_threshold` results came from `skill-trigger`: `god-object`,
`edit-through-link` and all three security cases answered without invoking
the skill. Those are genuine trigger misses, so the semantic passes for those
cases reflect the base model, not skill content. The one content false
negative (`god-object` rejecting "split by reason to change") was fixed in the
regex, and `command-review` no longer passes on a bare mention of "secret".
`report RUN_DIR` now prints those per-check results and Skill calls directly.

Tooling that redacts secrets in its display can silently rewrite what you
think a prompt says. Check the bytes of a case file, not the rendered view,
before authoring a rubric or sample from it.

This bounded run verifies the exercised Claude/Haiku archive-to-judge path,
not judge accuracy, calibration, general skill quality, or cross-provider
equivalence. The built-in judge profile is Claude-only; unsupported runtimes
and active machine-managed policy fail closed.

The top-level engine [JUDGE_PROMPT.md](https://github.com/bobthearsonist/ai-evals/blob/main/JUDGE_PROMPT.md)
is the actual packaged runtime prompt. It requires an independent verdict for
each criterion, accepts equivalent reasoning, and treats partial satisfaction
as failure. Pass/fail evidence must quote the captured answer exactly.

### Semantic scoring

The engine's [semantic scoring procedure](https://github.com/bobthearsonist/ai-evals#semantic-scoring)
is canonical. `judge RUN_DIR --client claude --model MODEL_ID` uses recorded
suite assertions and writes a separate combined score automatically: 50%
existing deterministic score and 50% whole-answer semantic verdict. All
semantic criteria must pass; criterion results remain diagnostic, independent
of row count. No labeled-answer acceptance artifact is required.

Use `--dry-run` first and approve the exact live session count separately.
Missing, invalid, abstaining, duplicate or mismatched assessments make affected
scores null. Prompt, policy, answer, runtime, model and settings provenance are
still checked. Original deterministic results and history never change.
The standalone `--rubric` compatibility path remains assessment-only.
Scoring measures the recorded assertions; it does not establish judge accuracy.

Historical measurements and frozen inputs remain in the [historical evidence archive](calibration/). They are not prerequisites for current scoring.

### Installed dependency

```powershell
npm ci --ignore-scripts
npm test
node local/cli.mjs preflight --client claude --model MODEL_ID
node local/cli.mjs run --suite security --model MODEL_ID --dry-run
node local/run-all.mjs
```

Run these commands from `evals`. `evals.json` resolves cases, skill roots and outputs relative to this directory; the thin wrappers supply its absolute path, so they also work when invoked from elsewhere. `cli.mjs` preserves the default `git-commit-style` suite except for `run-all`, which discovers all suites unless explicitly narrowed, and
`judge`, which reads the archived policy without injecting a suite. `run-all` prints the required session approval before any live execution. Preflight checks existing credentials without inference or login; it does not prove provider access. A live run requires a separately approved explicit model and exact session count.

Suites live in `local/cases/<skill>/*.feature`, with offline samples in
`*.samples.json`; fixtures and `.work` artifacts remain here. Tests validate
all 22 case IDs, require Gherkin definitions and check every offline sample
against the selected engine. Engine tests live in `ai-evals`.
Current results are labelled `acp-non-hermetic`; historical native results are
unsupported. Historical local run archives and one-off probe scripts have been
deleted; fresh runs and assessments require separate explicit approval.
