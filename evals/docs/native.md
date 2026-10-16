# Offline native plugin preflight (not native acceptance)

This independently owned layer imports contract hashing from `harness/index.mjs`
and the existing `harness/packaging` validator/generators. It neither implements
ZIP/export validation again nor changes shared schemas, CLI, generated plugins, CI,
publishing, portable suites, credentials or client settings.

## Evidence and limitations

Official reference read on 2026-10-07:
<https://code.claude.com/docs/en/plugin-evals>.
The default installed command was **2.1.292**. The existing versioned executable
`C:\Users\MartinPe\.local\share\claude\versions\2.1.291` was independently queried
with Node `execFileSync` using only `--version`, `--help`, and
`plugin eval --help`; the observed native flags were supported. Help observation
does not establish deterministic-only evaluator execution. PowerShell does not
reliably invoke that extensionless executable directly. No model calls, auth
inspection, eval invocation, trust grant or publication occurred.

Documentation establishes `case.yaml` schema `"1.1"`, fixed MCP mock Markdown,
and aggregate JSON `schemaVersion: 1`. It describes partial/error/abort/skipped
fields, but does **not** specify the complete per-grader result, transcript,
repeat identity and required evidence schema. Consequently
`normalizeNativeResult` **always throws unsupported**, including for documents
with score fields. There are no invented fixtures called captures, successful
parser paths, or normalized acceptance results. Future integration must establish
the actual machine format and preserve deterministic discovery/hard-check
evidence on **every** repeat, not infer acceptance from aggregate pass rates.

The pinned native evaluator may itself use LLM-based grading. No documented and
validated deterministic-only invocation has been established. Therefore
`planNativeCommands` **always throws unsupported**, even with exact human trust
approval: **native evaluator may use AI grading; deterministic delivery preflight
only**. It emits no eval command arrays and has no launch API. Offline preflight
does not establish model behavior or acceptance; no AI judges are required or
permitted by this layer.

Actual Claude/Copilot/OpenCode model execution belongs to their native clients
and normal client login. An external API key for a judge is not required. This
preflight neither reads auth state nor authenticates a client.

## Source-owned suite and mocks

`profisee-ai\evals\plugins\windows-powershell-patterns` owns two synthetic,
text-only cases: namespaced `Skill` discovery and reading the real bundled
`skills/windows-powershell-patterns/SKILL.md`. That skill currently has **no
additional resources or MCP/config file**; exact delivered absence is checked.
Both cases retain deterministic namespaced discovery and no-shell grader
definitions as **inert preflight data**, three repeats,
six turns, 90 seconds, and only Skill/Read/Glob/Grep. Programming, shell
execution, elevation, services and production are excluded. Cases are authored
as JSON in `case.yaml`: the documented YAML format's unambiguous JSON subset.
Only validated source case bytes are copied; no arbitrary source code executes
and no native evaluator consumes them here. AI criteria, rubric/LLM graders,
score expectations and obsolete judge profiles are rejected.

The native suite's independent `version: 1` and upstream case
`schema_version: "1.1"` are unchanged. Review binding `version` uses the shared
`CONTRACT_VERSION` (currently **2**), not either native format version.

The suite carries one **inert** source-owned native-syntax mock definition:

```text
evals/mocks/native-text-fixture/explain.md
---
type: fixed
expect:
  subject: [PowerShell]
---
Synthetic text-only fixture: cmdlets return objects. No service was contacted.
```

Per official docs, mocks are registered for servers **declared by the plugin**.
This plugin declares none, so that mock is delivery/config evidence only; it
cannot be claimed as a successful MCP call. No MCP declaration is synthesized
in a plugin to make it appear active. Agent mocks, replay code, real server
flags, MCP command/URL payloads and shell scaffolds are forbidden here.

## Reusable API

Import `harness/native/index.mjs` directly; there is no launch API.

| Export | Behavior |
| --- | --- |
| `NATIVE_VERSION`, `NATIVE_LIMITS`, `NATIVE_NORMALIZATION`, `NATIVE_EXECUTION` | Pinned runtime/limits and explicit unsupported normalization/execution states. Limits are inert binding data, not execution guarantees. |
| `inspectNativeRuntime({executable})` | Only help/version subprocesses; verifies 2.1.291, flags and exact executable/help hashes. Returns process-local runtime handle. |
| `loadNativeSuite({directory})` | Bounded source inventory, narrow known cases/graders/fixed mock, explicit limits; rejects unknown fields, symlinks, traversal, scaffolds and executable contexts. |
| `nativeBaselineBinding({packaging})` | Revalidates actual packaging and returns review-only `{snapshotId,pluginHash}`; never approves. |
| `createNativeOverlays({candidate,baseline,baselineApproval,suiteDirectory})` | Revalidates both packaging artifacts, requires supplied human baseline attestation, copies selected plugin plus source-owned native suite into separate owned arms. |
| `verifyNativeOverlays(handle)` | Rehashes exact inventory, resources, mocks and settings; detects missing/changed/extra fixture data. |
| `prepareNativeReview({overlays,runtime,profile})` | Returns `{review,bindingHash}` for independent operator review, never `approved:true`. |
| `planNativeCommands({overlays,runtime,profile,trustApproval})` | Validates fresh exact trust approval, then always throws unsupported. Never returns evaluator command arrays or executes. |
| `normalizeNativeResult(...)` | Always fails closed as unsupported. |
| `cleanupNativeOverlays(handle)` | Removes only exact process-owned UUID child, rejecting forged/reused handles and links. |

Packaging inputs use the existing shape
`{sourceDirectory,generatedDirectory?,snapshot?}`; generators' owned handle
already has this shape. Native work is under `harness\native\.work\native-UUID`,
never canonical generated plugins or skill trees. Payload files remain unchanged;
native `evals` is below each owned overlay plugin. Candidate and supplied
approved baseline are **two plugin arms**; neither is executed. The native
optional no-plugin arm is not an approved baseline.

Minimal preparation (after the existing disposable generators have run):

```js
const binding = nativeBaselineBinding({packaging: baseline});
// Operator supplies baselineApproval for hashObject(binding); no auto-approval.
const overlays = createNativeOverlays({
  candidate, baseline, baselineApproval, suiteDirectory
});
try {
  const runtime = inspectNativeRuntime({executable: pinned291Executable});
  const profile = {
    model: "claude-sonnet-4-6",
    provider: "native-client-auth", mockMode: "record"
  };
  const review = prepareNativeReview({overlays, runtime, profile});
  // Present review to the operator; this does not authorize evaluator execution.
  // Even exact approval cannot bypass unsupported execution.
  // planNativeCommands({overlays, runtime, profile, trustApproval}) throws.
} finally {
  cleanupNativeOverlays(overlays);
}
```

Both approval inputs require exactly:

```js
{
  bindingHash: "<exact reviewed SHA-256>",
  approved: true,
  reviewType: "human",
  reviewer: "<identified operator>",
  reviewedAt: "<ISO timestamp>"
}
```

These are externally supplied attestations, not signatures or identity proof.
Protect the approval channel against candidate control. Every new overlay path,
baseline, plugin/eval/settings/profile/mock/limit/runtime byte identity requires
new trust approval. Missing/stale attestations fail validation; exact approvals
still cannot produce an eval command. Profiles accept only explicit model IDs
and the fixed native-client-auth/mock-only shape; `judgeModel`, judge settings,
API/gateway auth and arbitrary extra fields are rejected. They grant no
credentials or provider authorization.

Settings remain the overlay-owned `{"disableAllHooks":true}`. The module does
not grant plugin trust, run a provider, start real MCP or invoke native
evaluation. Re-enabling native execution requires a separately established,
documented and validated deterministic-only invocation; selecting only builtin
grader definitions or observing flags in help is not evidence of that.

## Targeted validation

Requirements are the already installed eval dependencies, the existing local
offline packaging image, Docker, and the existing pinned Claude executable.
No automatic downloads/builds/installs:

```powershell
node --test --test-reporter=dot C:\Repositories\ai\evals\tests\native.test.mjs
```

Overrides: `PROFISEE_NATIVE_REPO`, `PROFISEE_NATIVE_EXECUTABLE`.
Tests use real existing source generators in their owned network-disabled Docker
snapshot, then use **synthetic test-only approvals**, never actual acceptance.
The cached packaging image supplies Node **22.22.1**; the observed Docker Engine
is **29.7.2**. Tests prove equivalent separate overlays, exact materialization/config absence,
missing-resource/leaked-fixture failures in real packaging and overlays, stale
trust rejection, AI criteria/obsolete profile rejection, ownership/path guards,
universal execution blocking even with valid trust, and universal normalization
blocking. Canonical dirty unrelated files are preserved.
