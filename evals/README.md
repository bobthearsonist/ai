# Deterministic local skill evaluation

This tooling evaluates the behavior of the **actual Claude Code, OpenCode and
Copilot CLI clients**. A model runs the task through its client; ordinary code
checks the resulting discovery events, artifacts and safety evidence.
**No AI model evaluates another model's results.** There is no LLM judge,
rubric score, quality threshold or pass-rate substitute for subjective quality.

The version-2 semantic contract, deterministic artifact checks, isolated offline
execution, three source-owned pilot suites, disposable Profisee packaging
checks, actual-client offline probes and native delivery preflight are
implemented. A pinned public portable-SDK callback route has now been proven
with all three actual clients in offline mode. Parameterized native tasks and
host-side grading are available through `run-offline`; authenticated live
orchestration is still outstanding. `run` deliberately exits nonzero rather than inventing
client execution or trusting unauthenticated result files.

## Client authentication

The clients use their **normal supported login/provider-authentication flows**.
Claude Code can use a Claude account login, Copilot can use its GitHub login,
and OpenCode uses its configured provider connection. A new Anthropic/OpenAI
API key is not a requirement of this stack. BYOK is an alternative client route,
not a mandatory evaluator dependency.

Live adapters must establish authentication for the isolated client profile
without importing the developer's whole HOME, instructions, skills, hooks or
credential stores. A login on the host does not prove that a Linux container has
access to it. No tool automatically reads personal credentials or copies them
into a test workspace. Accepted runtime/model pins, supported tool boundaries,
restricted service egress and explicit bounded execution authorization remain
necessary. Offline probes use synthetic credentials and scripted local
inference only.

Requirements: Node 22+, npm and Git for source exports; Docker's Linux engine
for the offline isolation, packaging and real-client probes. Ajv 8.17.1 is
pinned in `package.json` and `package-lock.json`. No dependencies, personal
client configuration, publishing behavior or CI pipelines are installed or
changed by invoking validation.

The runner integration has its own locked dependency manifest. Install it
separately with `npm ci --prefix harness\runner` before invoking `probe-runner`.
The same locked SDK installation is required for `run-offline`.
It pins `@vercel/agent-eval` 2.4.1 and audits the public callback route before
loading it. That route does not use Vercel Gateway, Sandbox or AI grading.

## Commands

From `C:\Repositories\ai\evals`, after dependencies have been installed:

```powershell
npm test
node harness\cli.mjs validate --suite tests\fixtures\example\suite.json --profile tests\fixtures\profile.json
node harness\cli.mjs validate --repo C:\Repositories\ai
node harness\cli.mjs validate --repo C:\Repositories\ai-private
node harness\cli.mjs validate --repo C:\Repositories\profisee-ai
node harness\cli.mjs dry-run --suite suites\ai-repo-management\suite.json --profile tests\fixtures\profile.json
node harness\cli.mjs dry-run --suite suites\ai-repo-management\suite.json --profile tests\fixtures\profile.json --cases explicit --clients copilot
node harness\packaging\cli.mjs check --repo C:\Repositories\profisee-ai
node harness\cli.mjs probe-clients --timeout-seconds 180
node harness\cli.mjs probe-clients --clients opencode --timeout-seconds 180
node harness\cli.mjs probe-runner --clients opencode --timeout-seconds 180
node harness\cli.mjs run-offline --suite <suite.json> --profile <offline-profile.json> --skill-path skills\example-skill --candidate-export <absolute-export-directory> --baseline-export <absolute-export-directory> --mock-scenarios <scenarios.json> --cases explicit --clients copilot
node harness\cli.mjs prepare-live --suite <suite.json> --profile <native-profile.json> --skill-path skills\example-skill --candidate-export <absolute-export-directory> --baseline-export <absolute-export-directory> --cases explicit --clients copilot
node harness\cli.mjs prepare-auth --clients claude-code,opencode,copilot
node harness\cli.mjs run
```

`dry-run` enumerates tasks without launching clients. The fixture profile is
synthetic planning data, not approval to run live models. Each of the three
pilots has four cases, three clients, candidate/baseline arms and exactly three
fresh repeats: **72 sessions per suite, 216 total**. A selected smoke is not
authorization for that full matrix.

`run` validates supplied suite, profile and selectors before reporting the
missing execution adapter and selected session count. Validation does not
authenticate a profile or authorize a model call.

`probe-runner` dispatches one native offline probe per selected client through
the pinned SDK's public `registerAgent`/`runSingleEval` route, with no retries.
Its timeout is 1-300 seconds per client. This proves SDK integration only; its
report is not a version-2 case matrix, baseline approval or live acceptance.
The SDK's built-in experiment retry and AI validation paths are not used.

`run-offline` dispatches the selected case matrix through that public SDK route:
exactly three fresh native executions for every selected case/client/arm,
sequentially, without retries or early exit. It requires exported candidate and
baseline directories containing validated `snapshot.json` manifests, an
explicit relative skill directory and one public mock scenario per selected
case. Scenario JSON is an array such as
`[{"caseId":"explicit","loadSkill":true,"artifacts":[{"path":"plan.txt","content":"Independent public fixture output"}]}]`.
These are deliberately supplied protocol fixtures, never responses synthesized
from expected checks or private answer keys. The no-skill arm receives no
target-skill bytes and cannot request its loading.

An offline profile must use `auth: "none-offline"`, runner
`"@vercel/agent-eval@2.4.1"` and the pinned client versions below. Seconds are
1-300 per task; execution concurrency is one. Actual image/runtime observations
are recorded, but profile model/image/service pins and turn/token limits are
**not** applied or claimed. Native adapter-specific input caps and unsupported
skill/configuration features remain enforced; rejection is an explicit failed
slot, not a fabricated result.

Host code grades each original trusted artifact capture, validates discovery
and usage provenance, and rejects capture reuse or conflicting adapter claims.
Pinned OpenCode receipts must retain their audited stdin-newline envelope and
the hash of the complete observed wire message; missing or conflicting framing
evidence makes the slot incomplete.
Each attempted slot, check evidence and exact artifact bytes (base64 plus hashes)
are retained under a fresh owned `evals\.work\isolation-<UUID>\evidence`
directory. The CLI prints the manifest, each slot's first failure/error and
evidence location, and exits nonzero on diagnostic failure. Full check/failure
details remain in each slot's evidence file. Native integration failures retain
their diagnostic evidence instead of discarding it during test cleanup.
Only an API-held original workspace handle may remove
that invocation; never sweep `.work`.

The persisted format is explicitly an **offline diagnostic matrix**, not
version-2 accepted results. Successful mocks do not prove model behavior,
normal authentication, live containment or human baseline approval. The
candidate and baseline export names do not grant either approval.

`prepare-live` binds exact current source/context/profile bytes and three-repeat
coordinates to a native execution proposal. It prints exact baseline and
account-consumption approval targets but does not log in, verify containment,
apply limits or start model execution. No mock answers or credential/boundary
assertions are accepted. An optional externally supplied `--authorization`
record binds exact expiring account-consumption ceilings; it does not verify
their enforcement or grant live acceptance. See [live preparation](docs/live-execution.md).

The host-only native preparation bridge binds original evaluation, boundary,
candidate and custody handles to each client's mock-free task specification.
It excludes host checks/private answers and rejects stale or mismatched
bindings, but does not log in or execute model tasks. The boundary now supports
original native image attachment; the host bridge can separately inspect that
original candidate and image for timestamped version/help-only runtime
observations. Those observations do not grant credential, effective-limit or
live-task authority. An optional original local-OCI manifest observation can
verify the per-client manifest/config pin; equal Docker image-ID text alone
does not verify that relationship or grant registry trust. Claude's hidden
scoped native turn flag is planned from the profile, not claimed applied.
Hard aggregate-token/account guarantees and independent credential/tool
separation remain explicit live blockers.

The host can also prepare one original tool worker from captured public bytes,
start and lease its transport once, and bind that exact tuple to the same
evaluation/task index. Its fixed worker limits and fresh kernel assertions do
not prove native MCP consumption, Skill discovery or authenticated containment.
The host can verify declared worker artifact bytes, create an original
immutable host capture and grade private checks without exposing answers to
the worker. This remains worker-filesystem evidence, not native acceptance.
Remove the exact native consumer before closing its worker; evaluation release
refuses to orphan an owned worker. See [the host transport API](docs/live-execution.md#captured-public-tool-transport).

`run-live` now persists fail-closed admission diagnostics for every planned
coordinate through the pinned public host scheduler. This is not a live task
matrix: host callback attempts are counted separately, native dispatch counts
remain zero, and execution/model/usage/capture evidence stays null until
supported native admission exists. The command exits nonzero and does not
accept injected executors, credentials or caller-supplied containment proofs.

`prepare-auth` creates empty owned profiles and prints normal native login and
status command plans. It does **not** execute those commands, inspect personal
credentials, inherit provider tokens or authenticate anything. Successful
preparation leaves the directories available for deliberate operator use;
the API handles are process-local, not reusable serialized authentication
evidence. Native OS credential services and policy are not isolated by changing
HOME alone. Plans require an isolated credential-store boundary and resolved
native executable before operator execution; do not merge their replacement
environment with your personal environment. See [auth preparation](docs/auth.md).

CLI output is JSON except help; errors are structured JSON on stderr. Invalid
schemas, missing dependencies, empty/duplicate/unknown selections, unsupported
execution and failed gates exit nonzero. `validate --repo` searches only the
source repository's `evals\suites\*\suite.json`; no suites is not success.
Case/client/arm selectors are comma-separated. Candidate and baseline are
required; `no-skill` is an optional diagnostic, never a replacement baseline.

The export and report commands operate on explicitly supplied files:

```powershell
node harness\cli.mjs export --repo C:\Repositories\ai-private --tracked skills\git-commit-style
node harness\cli.mjs report --suite <suite.json> --results <results.json>
node harness\cli.mjs report --suite <suite.json> --results <results.json> --previous <prior-results.json>
```

`--tracked` and `--untracked` can be repeated. `--untracked` requires exact
existing files. `--previous` supplies prior execution IDs for reuse detection.
`report` validates mapped results; it does not authenticate their origin or
replay raw client traces. An accepted execution adapter must obtain those
results from trusted captures, not candidate-written success claims.

## Deterministic acceptance

Every selected case/client/arm requires exactly **three fresh executions** with
unique execution IDs and the current invocation ID. Cached, missing, duplicate,
extra, stale, skipped, cancelled, errored or timed-out runs cannot pass.

Every candidate repeat must satisfy:

- Actual target-skill loading for explicit and implicit cases.
- Complete discovery-audit evidence and no target-skill load for negative cases.
- Every declared correctness and safety assertion, with trusted evidence.
- Exact compatible fixture, profile, runtime, model and snapshot identities.

The optional no-skill control must have a known unloaded state and no target
skill-load evidence. Candidate prose that says a skill was used is not a trace.
An unknown or blank observed native model cannot pass, even if all comparison
slots declare the same requested model; `null` remains valid diagnostic data
but is not proof of compatible native execution.
Missing, duplicate, unknown, misclassified, skipped or errored required checks
fail closed. A useful answer cannot hide an execution or safety failure.

Regression is against an explicitly approved, compatible baseline and its
deterministic outcomes. Baseline failures are recorded as baseline behavior;
they cannot excuse candidate failures. Incomplete baseline execution or required
evidence is not a valid comparison. These checks establish declared behavior,
not a continuous measure of accuracy, usefulness or overall model quality.
Subjective review can occur separately; it is not an automated AI gate.

## Suite and result contract

`schemas\contract.schema.json` defines `suite`, `profile`, `snapshot`,
`baseline`, `run` and `results`. Semantic documents use `contractVersion: 2`.
The earlier scored version-1 format is rejected, not silently interpreted as
deterministic acceptance. Unknown versions and fields fail closed.

| Surface | Required meaning |
| --- | --- |
| Suite | Stable ID/skill, supported clients, explicit context dependencies and nonempty uniquely named cases. |
| Case | Literal prompt, explicit/implicit/negative expectation and nonempty required hard checks. No AI rubric. |
| Check | Unique ID, correctness/safety class, known type, explicit target and expected value. No executable grader DSL. |
| Profile | Exact runner/image/client/model/service/settings/auth-route pins, finite turns/tokens/time/concurrency, no early exit or cache. No judge model. |
| Snapshot | Selected working-tree bytes, deletion and executable identity, source provenance and content-bound snapshot ID. |
| Baseline | Exact snapshot/profile identity, released or bootstrap provenance and externally supplied human approval. |
| Run | Matrix coordinates/freshness/status, compatible identity, actual discovery/check evidence, usage and artifact references. No AI grade or rubric hash. |
| Results | Current invocation, suite, profile, selection, both snapshots, approved baseline and complete normalized runs. |

Checks include `artifact-exists`, `artifact-contains`, `artifact-not-contains`,
`trace-event` and `manual-evidence`. The artifact executor supports only the
artifact checks today. Trace/manual checks error until an accepted trusted
adapter exists; a candidate-written trace or boolean cannot unlock them.

Dependencies explicitly declare availability and visibility. Provided files
must exist; unavailable dependencies are not silently supplied. `mountRoot`
is `home` or `workspace` and defaults to workspace. `home` means only the
isolated synthetic HOME, never a developer profile. There is no magic `home\`
prefix. Paths, separator/dot normalization, case-insensitive collisions and
ancestor-file collisions are checked within each root/visibility namespace.

The historical visibility value `judge` identifies **trusted grader-private
data**, not an AI judge. Those bytes remain excluded from candidate context.
Fixed good/broken artifact specimens are unit-test data, never model-visible
answer keys. Changing prompts, checks or context bytes invalidates fixture
identity; changing client settings/model/auth/image invalidates profile identity.

Usage keeps token, time, USD and credit metrics separate. A genuinely unknown
value is `null` with unavailable provenance, not zero or an estimated conversion.
Synthetic fixture token counts are not actual model billing.

## Source and artifact ownership

Canonical suites are owned by their source repositories:

| Repository | Pilot |
| --- | --- |
| `ai` | `evals\suites\ai-repo-management` |
| `ai-private` | `evals\suites\git-commit-style` |
| `profisee-ai` | `evals\suites\windows-powershell-patterns` |

Prompts, expected artifacts, results and private checks stay outside distributed
skills, plugins, Desktop bundles and client discovery paths. The fixture suite
under `tests\fixtures` is not discovered as a production suite.

`exportCandidate` reads selected **current working-tree bytes**, including dirty
and staged edits plus explicitly named untracked files. It never substitutes
HEAD or checks out, stashes, resets, restores, commits or modifies the source.
Selected tracked deletions remain deleted. Missing dependencies and empty
exports fail.

Exports occupy unique owned `export-<UUID>` children of `evals\.work` or the
source repository's `evals\.work` via `--work-root`. Arbitrary output roots and
symlinked ancestors are rejected. Each export contains the files and a content
manifest. Contained links are materialized as bytes; escaping links are rejected.
Windows executable identity comes from the Git index; unmerged entries fail.
Only the exact owned invocation can be cleaned. Never sweep `.work`, prune
Docker or remove another invocation's artifacts.

Baseline provenance is either a verified release artifact or an explicitly
human-approved bootstrap snapshot. A commit/version alone is not release proof.
Approval binds exact content and is an operator attestation, not cryptographic
identity proof. There is no automatic approval or baseline-promotion command.

## Implemented modules and limitations

| Module | Working behavior |
| --- | --- |
| [Artifact checks](docs/checks.md) | Immutable hash-bound captures and deterministic outcomes; missing/escaping/unreadable content fails explicitly. |
| [Isolation](docs/isolation.md) | Fresh synthetic HOME/workspace/config, private-data exclusion, no-network/read-only controls, redaction, timeout/cancellation/concurrency and owned cleanup. Live mode remains blocked. |
| [Packaging](docs/packaging.md) | Actual existing generators in disposable snapshots, source-to-payload/resource/config/ZIP checks and no eval-data leakage. No canonical generated writes. |
| [Claude Code probe](docs/clients-claude-code.md) | Pinned actual 2.1.291 discovery/tool/artifact and denial evidence against scripted local inference. |
| [OpenCode probe](docs/clients-opencode.md) | Pinned actual 1.14.28 native tool/artifact and scoped permission evidence against scripted local inference. |
| [Copilot probe](docs/clients-copilot.md) | Pinned actual 1.0.92 native tool/artifact and scoped denial evidence against scripted local inference. |
| [Native preflight](docs/native.md) | Deterministic plugin delivery, bounded source inventory, separate overlays and exact supplied approval bindings. Native evaluator launch is not an accepted deterministic gate. |
| [Local SDK route](docs/runner.md) | Pinned public SDK custom callbacks and actual three-client offline proof, without built-in sandbox, AI judge or hidden retries. Not a live case runner yet. |
| [Native auth preparation](docs/auth.md) | Empty owned profiles and supported native login/status plans; no automatic login, credential copying or authentication claim. |
| Native case matrix (`harness\task-execution.mjs`) | Explicit offline case/skill/context bytes, public SDK three-repeat scheduling, original host captures, deterministic checks and persisted per-slot evidence. Not live or approved baseline acceptance. |

Each actual-client probe has passed through `probe-clients` with the 180-second
option. Successful probes verify native creation of `answer.md` and
`message.txt`, disk bytes, protected-path denials and fresh no-skill controls.
They never substitute stdout for a file. Reports have explicit offline-mock
provenance and cannot become live model-quality acceptance.

Hash integrity is logical, not physical isolation from privileged same-host
attackers. Docker alone does not protect credentials from client tools or
establish restricted outbound traffic. Authentication, complete live task
orchestration, accepted raw-event normalization, limits and service egress still
require implementation and actual-client acceptance. No real model call, host
login mutation, plugin trust grant, publication or CI rollout is implied.

## Shared JavaScript API

Import named ESM exports from `harness\index.mjs`:

`CLIENTS`, `CONTRACT_VERSION`, `POLICY`, `ContractError`, `canonicalJson`,
`hashContent`, `hashObject`, `validateDocument`, `readJson`, `resolveContained`,
`loadSuite`, `discoverSuites`, `planRuns`, `snapshotIdentity`, `validateSnapshot`,
`exportCandidate`, `validateUsageMetrics`, `normalizeRun`, `evaluateResults`, and `runEvaluation`.

`harness\task-execution.mjs` exports `prepareOfflineCaseMatrix`,
`executeOfflineCaseMatrix` and `persistOfflineCaseMatrix`. Execution returns the
diagnostic report and original in-process capture handles; persistence returns
the owned workspace handle, manifest and report filename.

`planRuns` is planning only. `normalizeRun` validates an already explicitly
mapped deterministic run; it does not infer raw event shapes.
`evaluateResults` is a pure fail-closed offline gate, never a baseline approver.
`runEvaluation` throws until accepted real execution exists.
