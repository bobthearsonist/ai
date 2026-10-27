# Skill evals (local, ACP)

Repository-owned cases for the shared [ai-evals engine](https://github.com/bobthearsonist/ai-evals). The development dependency pins the engine by commit; no engine implementation is duplicated here. Claude and Copilot use only ACP. OpenCode remains unsupported.

See [repository evaluation notes](../docs/skill-evaluations.md).
The [AI Guild onboarding page](docs/ai-guild-evals.html) explains the workflow,
current evidence and limitations; [Teams draft](docs/ai-guild-teams-blurb.md).

### Engine dependency

The current `c697dfa` update is local-only pending review; publish that engine
commit before installing this pin from GitHub. Validation used the identical
commit installed from the local Git repository, not an uncommitted symlink.

`package.json` pins `@bobthearsonist/ai-evals` to a commit on the engine's
repository, which provides multi-runner selection, Gherkin authoring, shared v2
assertions, ACP transport and separately opt-in AI judging. To pick up a newer
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

`And the AI judge confirms "semantic-expectations":` Doc Strings co-locate
meaning-based criteria with nine positive Gherkin scenarios:
repository-change delivery, responsibility-based decomposition, both
complexity assessments, both pattern-adoption decisions, and the three
security-advice cases. Exact commit syntax, identifiers, negative controls,
skill activation and disclosure patterns remain deterministic. Existing
regex proxies are retained for historical comparison, **not treated as a
semantic verdict**. Advisory judgements do not replace or change those scores.

Selection was informed by a prior evaluation investigation: correct answers failed on paraphrases
such as "shouldn't postpone" versus "don't block", "quietly" versus "silent",
and reasons outside a 150-character window. The rubrics accept equivalent
reasoning throughout the answer rather than expanding patterns to fit saved
outputs. Rubrics are authored criteria, not measured
judge accuracy, and existing regex samples are not semantic calibration data.

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

Scoring remains advisory until an explicit calibration artifact passes the
engine's gate: 40 unique reviewed answers, five exact case policies, four pass
and four fail labels per policy, and 100% agreement without invalid/abstaining
results. `calibrate --labels PATH --client claude --model haiku --dry-run`
plans it; live calibration needs its own exact approval. Only covered policies
may use `judge --calibration PATH`, which writes a **separate** combined score
without changing deterministic results/history. Prompt/model/runtime/settings
changes require recalibration; missing or invalid judgments make scores null.
See the engine README for the label format and commands.

The 2026-10-26 bounded Claude `haiku` calibration agreed with **37/40 labels
(92.5%)**: one equivalent answer was wrongly rejected, and two verdicts were
invalid because they used Markdown JSON fences. There were no abstentions or
false acceptances. The 40 labels cover five exact policies, with four positive
and four negative examples each; they are authored synthetic examples, **not
independently human-reviewed production responses**. The gate failed, and the
saved artifact was verified to reject scoring. For that configuration, judging
remained advisory; no candidate scoring sessions or retries were run. Runtime-reported list-price
usage totaled about **$0.049**, not an additional subscription charge.
See [labels](calibration/judge-labels.json) and the
[recorded result](calibration/result-2026-10-26.json) for scope, failures and
prompt/runtime fingerprints. Full assessments remain in the local ignored archive.

The historical v2 prompt removed the fenced output example and clarified paraphrase
acceptance and whole-answer review. It was frozen before 40 fresh authored
answers were added to the original 40 regression answers. Each revised
configuration ran once against all 80, without changing labels, criteria or
the 100% gate:

| Judge | Agreement | Invalid / abstaining | Gate | Reported usage |
|---|---|---|---|---|
| Revised Claude `haiku` | 72/80 (90%) | 0 / 0 | blocked | $0.093 |
| Revised Claude `sonnet` | 79/80 (98.75%) | 0 / 0 | blocked | $1.182 |
| Revised Claude `opus` | 80/80 (100%) | 0 / 0 | passed for five exact policies | $2.332 |

Haiku was subsequently tested once with the same frozen revised prompt, 80
answers, timeout and gate. All eight errors were false rejections: three
on `pain-gate` and five on `before-after`. Some rejected equivalent reasoning;
others claimed explicitly present requirements were missing. JSON formatting
was valid throughout. This gives a same-prompt comparison, not evidence that
all output judging needs Opus. V2 Haiku remained advisory; no defaults changed.
See the [revised Haiku result](calibration/result-2026-10-26-haiku-v2.json).
Usage figures are runtime-reported list estimates, not additional subscription
charges; Opus used about 25 times Haiku's reported cost on these 80 answers.

Sonnet rejected a valid paraphrase of coupling/cohesion; its saved artifact
was verified to block scoring before inference. Opus was selected after that
failure on the same labels. These are **authored model-selection examples,
not an untouched final test set, independent human review, or a population
accuracy estimate**. The fresh half scored 40/40 for both models. Reliability
does not transfer to the other four toolkit policies or any Profisee policy.
Future provider changes behind the `opus` selection ID also need validation.
See the [Sonnet result](calibration/result-2026-10-26-sonnet-v2.json),
[Opus result](calibration/result-2026-10-26-opus-v2.json) and
[frozen fresh labels](calibration/judge-labels-holdout.json).

Using the passing Opus artifact explicitly, two independently generated Haiku
candidate answers were then judged: both semantic verdicts passed. Combined
scores were 1.00 for `incremental` and 0.80 for `pain-gate`, averaging **0.90**.
The original deterministic average remains **0.875**, byte-for-byte unchanged
along with all 11 original archive files. The remaining regex failure rejects
"No, don't do it now"; it was retained rather than silently repaired during
measurement. Exit 1 reports that remaining quality-check failure, not an
execution error. The two judge sessions reported about $0.070 in list-price
usage; none of these estimates is an additional subscription charge.
See the [live scoring evidence](calibration/scoring-2026-10-26-opus-v2.json).
This one-arm smoke verifies the scoring path, not skill lift. Default judging
remains advisory; separate combined scoring requires the full local calibration
artifact, exact matching configuration and covered policy hashes. The summary
JSON files are not accepted calibration artifacts.

### Evidence-first Haiku judge (current v3)

The packaged prompt now checks acceptance rather than critiquing answers:
quote relevant evidence first, explain coverage of every required claim, then
choose the verdict. It distinguishes a requested assessment plan from completed
measurements, so the judge does not invent requirements. Strict JSON, exact
quote validation, criteria, weights and the **100% gate are unchanged**.

With that frozen prompt, Claude `haiku` passed **80/80 regression answers and
40/40 fresh blind answers** on the first attempt for each set: no false
acceptances, false rejections, invalid outputs or abstentions. The fresh set
was independently authored by a separate AI agent using only the five
contracts, without the judge prompt, previous answers or results; the tuning
agent did not inspect it before the prompt was frozen. These are synthetic
AI-authored labels, **not independent human review or production accuracy**.
Both full artifacts pass the unchanged gate for the same five exact policies:
`pain-gate`, `incremental`, `god-object`, `before-after` and `score-god-class`.
The other four toolkit policies and all 116 Profisee policies remain advisory.

Reported list-price usage was **$0.100501 for 80** plus **$0.049394 for 40**,
about **$0.150 total**, not an additional subscription charge. The 80-answer
run cost about 23 times less than the earlier Opus run, but their prompts
differed; this is not a controlled same-prompt cost benchmark. See the
[v3 calibration result](calibration/result-2026-10-27-haiku-v3.json) and
[frozen blind labels](calibration/judge-labels-holdout-v3.json).

The installed consumer then used the blind passing artifact to judge the same
two independent archived candidate answers: both semantic verdicts passed;
the separate combined score is **0.90** and original deterministic score
**0.875**, with all 11 original files unchanged. See
[Haiku scoring evidence](calibration/scoring-2026-10-27-haiku-v3.json).
This checks the live scoring path, not skill lift. Default judging remains
advisory; scoring requires the full local artifact and exact matching settings
and policies. Earlier prompt artifacts, including the passing v2 Opus artifact,
are historical and cannot authorize scoring with this prompt. Summary JSON is
not accepted as a calibration artifact. No model defaults changed.

### Installed dependency

```powershell
npm ci --ignore-scripts
npm test
node local/cli.mjs preflight --client claude --model MODEL_ID
node local/cli.mjs run --suite security --model MODEL_ID --dry-run
node local/run-all.mjs
```

Run these commands from `evals`. `evals.json` resolves cases, skill roots and outputs relative to this directory; the thin wrappers supply its absolute path, so they also work when invoked from elsewhere. `cli.mjs` preserves the default `git-commit-style` suite except for `run-all` and `calibrate`, which discover all suites unless explicitly narrowed, and
`judge`, which reads the archived policy without injecting a suite. `run-all` prints the required session approval before any live execution. Preflight checks existing credentials without inference or login; it does not prove provider access. A live run requires a separately approved explicit model and exact session count.

Suites live in `local/cases/<skill>/*.feature`, with offline samples in
`*.samples.json`; fixtures and `.work` artifacts remain here. Tests validate
all 22 case IDs, require Gherkin definitions and check every offline sample
against the selected engine. Engine tests live in `ai-evals`.
Current results are labelled `acp-non-hermetic`; historical native results are
unsupported. Historical local run archives and one-off probe scripts have been
deleted; fresh runs and assessments require separate explicit approval.
