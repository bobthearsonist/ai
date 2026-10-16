# Pinned public local SDK callback runner

`harness\runner` owns an isolated package and lock with
**`@vercel/agent-eval` exactly 2.4.1**. It does not change the parent package,
shared CLI, client implementations or the live execution guard.

## What is eligible

The public package root exports `registerAgent`, `runSingleEval` and
`runExperiment`. Only **`registerAgent` + scalar-model `runSingleEval`** are used
for execution. The public `getAgent`/`listAgents` registry APIs additionally
detect a conflicting/replaced callback registration.

The installed 2.4.1 declarations specify:

```typescript
registerAgent(agent: Agent): void;
runSingleEval(fixture: EvalFixture, options: {
  agent?: string;
  model: string | string[];
  timeout: number;
  apiKey: string;
  validation?: 'vitest' | 'none';
  sandbox?: 'docker' | 'vercel' | 'auto';
  agentOptions?: Record<string, unknown>;
  // Other upstream options are deliberately not exposed by this wrapper.
}): Promise<EvalRunData | EvalRunData[]>;
```

This excerpt summarizes the relevant fields; the authoritative conditional
generic declaration is `dist\lib\runner.d.ts`. `timeout` is seconds at the SDK
boundary, converted to milliseconds for the callback.

**Actual pinned implementation:** `dist\lib\runner.js:282–318` resolves the
explicit registry entry, iterates the supplied models, calls `agent.run` once
per model, and converts the result with `agentResultToEvalRunData`. The wrapper
always supplies one scalar sentinel (`offline-probe-only/not-a-model`) and a
custom agent name. It never accepts caller-supplied SDK settings or keys.
The sentinel is not an approved model and is not forwarded to inference.

The registered callback owns execution: it invokes existing `probeClients`
validation, which calls the selected native client's `runOfflineProbe`.
`validation:'none'` prevents requesting SDK EVAL execution; more importantly,
the custom callback never enters the SDK built-in agent orchestrator at all.
Its unused installation/config/auth methods throw if incorrectly invoked.
No SDK sandbox, gateway, provider API, classifier or judge is called. Merely
omitting the SDK `judge` option is **not** the safety argument: built-in agents
can self-grade. Avoiding their entire execution path is.

Public source inspected at npm's published `gitHead`:
[README at 14ff85b](https://github.com/vercel-labs/agent-eval/blob/14ff85b9c413d49020c1794c86af0f5a2a5e3a6b/README.md).
The README documents both deterministic assertions and optional agentic judges;
the latter are prohibited here. The actual published tarball's source and
declarations, not guesses from current-main docs, establish this route.

## What is rejected

- `runExperiment`: `dist\lib\runner.js:196–214` retries suspiciously fast failures
  up to five times. No public disabling option removes that retry loop.
- `runWithDefinition`: private orchestration implementation, absent from
  package-root exports and the package export map. It is not imported.
- SDK built-in agents, the upstream CLI, default gateway agent/model, result
  reuse, early exit, pass-rate summaries, classification and AI grading.
- Automatic login, credential reads/copying, trust or permission bypass,
  global configuration changes, live provider requests and baseline approval.

The package transitively installs AI/Vercel SDK packages because they are
upstream dependencies; installation is not authorization to execute them.
Installation scripts are disabled. There is no large fork, private import or
custom replacement of the SDK retry loop.

## Local API

```javascript
import {
  getSdkProvenance, runOfflineSdkProbes, requireLiveRunner
} from './evals/harness/runner/index.mjs';

getSdkProvenance(); // Checks exact package, lock integrity and audited source hashes.
const evidence = await runOfflineSdkProbes({
  clients: ['claude-code', 'copilot', 'opencode'],
  timeoutSeconds: 180
});
requireLiveRunner(); // Always throws; no live adapter exists here.
```

`runOfflineSdkProbes` rejects unknown/empty/duplicate selections and noninteger
timeouts outside 1–300 seconds before loading a client. It runs sequentially,
creates fresh invocation/execution UUIDs, and requires exactly one SDK callback
per selected client. Errors propagate immediately with **zero retries**. Later
clients are not launched after failure. Issued callback tokens are removed in
`finally`, including failed invocations.

Each callback passes exactly `['answer.md', 'message.txt']` and the requested
timeout to the existing client API. That API owns the fresh Docker containers,
scripted loopback inference, deterministic discovery/artifact/denial checks and
scoped cleanup. SDK timeout is only forwarded metadata, **not an SDK-enforced
wall-clock cancellation**. Client-specific time limits and image-build limits
remain authoritative; a complete multi-client invocation can take longer than
the requested per-client/per-container timeout.

Returned evidence includes pinned SDK version, npm tarball/integrity, six
audited callback-path source SHA-256 hashes, unique IDs, callback counts,
SDK result status/duration and validated native reports. A changed audited
source or SDK registry entry fails closed. These hashes are a reproducibility
check, **not an exhaustive transitive-dependency audit or authentication proof**.
SDK `passed` means the deterministic offline probe succeeded, not that a live
skill-evaluation case passed.

The optional second argument `{loadClient}` is a unit-test injection seam.
Its reports are always labeled `evidenceSource:'injected-test-callbacks'`;
they must not be claimed as actual native execution. Normal calls use the
existing actual client modules and return `actual-native-offline-probes`.

## Reproduce and exact proof

```powershell
Set-Location C:\Repositories\ai\evals\harness\runner
npm ci --ignore-scripts --no-audit --no-fund
node --test C:\Repositories\ai\evals\tests\runner.test.mjs
node C:\Repositories\ai\evals\harness\runner\prove-offline.mjs
```

The proof script runs all three actual probes, writes a fresh JSON capture
only under this runner's ignored `.proof` directory, and prints its location
and a compact summary. It does not overwrite client fixture captures.
Builds may download pinned public npm packages; runtime containers remain
network-none with their existing synthetic local fixture providers.

Verified **2026-10-08** through the installed public SDK:

| Client | Actual version | SDK callback count | Deterministic pilot writes |
| --- | --- | --- | --- |
| Claude Code | 2.1.291 | 1 | verified |
| Copilot CLI | 1.0.92 | 1 | verified |
| OpenCode | 1.14.28 | 1 | verified |

Invocation: `6bc51f95-f999-4024-bca0-64bbb893933e`.
Local raw evidence:
`harness\runner\.proof\6bc51f95-f999-4024-bca0-64bbb893933e.json`.
This file is ignored, not a distributed fixture or a baseline.

An optional native integration test repeats that proof:

```powershell
$env:EVAL_RUNNER_NATIVE_OFFLINE='1'
node --test C:\Repositories\ai\evals\tests\runner.test.mjs
Remove-Item Env:\EVAL_RUNNER_NATIVE_OFFLINE
```

Original probe-only targeted validation: **8/8 passed**, including all three real native
offline callbacks (209.4 seconds for the native subtest). Without opt-in,
that original test set had seven unit tests and one skipped native subtest. Tests cover public
source provenance, callback cardinality/fresh IDs, zero fast-failure retries,
incompatible/live-shaped evidence, invalid selections/limits, unissued tokens
and SDK registry replacement.

## Remaining integration boundary

This proves the public local callback route, **not the live pilot or contract-v2
matrix**. Each client probe internally exercises its own candidate/control and
denial fixtures; those are not selected suite case/client/arm repetitions.
The returned object is deliberately not a schema-v2 `results` document and
sets `contractMatrixComplete:false`, `liveAccepted:false`,
`authenticationVerified:false`, `qualityEvaluated:false` and
`baselineApproved:false`.

A live coordinator still needs explicitly authorized, narrowly scoped native
authentication; verified isolation/service egress and runtime/model pins;
fresh trusted native captures mapped into v2 load/check/usage/artifact evidence;
and a compatible human-approved baseline. It must schedule exactly **three
fresh unique executions per selected case/client/arm**, without cache, retries
or early exit, then use the existing deterministic gates. This wrapper does
not manufacture discovery traces, accept candidate-authored success claims,
approve a baseline, or unlock shared `run`. No paid or real-model calls were
made to obtain the offline proof.

## Generic offline native task matrix

`runOfflineTaskMatrix` is an additional **outer scheduling API**, using the
same audited public SDK callback bridge. It does not change
`runOfflineSdkProbes` failure/early-stop behavior or its retained actual proof.

```javascript
import { runOfflineTaskMatrix } from './evals/harness/runner/index.mjs';

const batch = await runOfflineTaskMatrix({
  tasks: preparedNativePayloads,
  timeoutSeconds: 180
});
// Pass batch.attempts[n].receipt directly to the owning deterministic grader.
// Do not reconstruct/JSON-clone it: capture handles carry WeakMap identity.
```

Signature:
`runOfflineTaskMatrix({tasks, timeoutSeconds = 180} = {}, {loadClient} = {})`.
`tasks` contains exact native API envelopes:

```javascript
{
  task: {
    invocationId, caseId, client,
    arm: 'candidate' /* or baseline, no-skill */,
    repeat: 1 /* or 2, 3 */,
    fixtureHash: '64 lowercase hexadecimal characters'
  },
  prompt: 'Explicit caller prompt',
  skill: {
    id: 'target-skill',
    files: [{ path: 'SKILL.md', content: 'Explicit source bytes', executable: false }]
  },
  inputs: [{ path: 'input.txt', content: 'Explicit context', mountRoot: 'workspace' }],
  checks: [{ id: 'exists', class: 'correctness', type: 'artifact-exists', target: 'answer.md', expected: true }],
  mock: { loadSkill: true, artifacts: [{ path: 'answer.md', content: 'Independently scripted output' }] }
}
```

Inputs and skill-file contents may be strings or Buffers; executable flags are
optional booleans. Inputs support `mountRoot:'home'|'workspace'` (default
workspace). An empty skill-file list is permitted only for no-skill slots;
candidate/baseline slots still require explicit skill files.
Mock artifacts are explicit string contents, never generated from
checks or private specimens. Checks are validated against the existing schema,
not executed by this wrapper. Their expected values remain host-side arguments
to the native adapter; native adapters own keeping them outside model context.

The entire batch is validated **before SDK/client loading**:

- Nonempty array, at most **512** tasks; timeout integer **1–300** seconds.
- One nonempty invocation ID across all supplied tasks; no generated replacement.
- Supported clients; exact unique coordinates and repeat numbers 1, 2, 3.
- Candidate and baseline required. Selection sets are inferred across the batch:
  every selected case/client/arm combination must contain all three repeats.
  If no-skill is included, it is included for every selected case/client pair.
- Consistent fixture hash per case, explicit prompt/skill/check/mock data,
  normalized nonescaping relative file paths and no overlapping/duplicate files
  within each input mount-root namespace.
- Optional per-payload `timeoutMs` must equal `timeoutSeconds * 1000`; otherwise
  omit it. The wrapper assigns that value to each native callback.

Prepared payloads are independently copied and their object/array metadata
frozen before SDK loading; Buffer contents are separately copied without
conversion into Uint8Arrays. Native output receipts are **never copied**.

Each slot gets a wrapper-owned fresh `attemptId` before loading its adapter.
The same fixed SDK registry agent is reused; issued per-slot contexts are
deleted in `finally`, including failures. Execution is sequential, one public
`runSingleEval` call and at most one native callback per slot, with no retries.
Unlike the old probe API, failures **do not stop later matrix slots**.

### Result and failure rows

```javascript
{
  invocationId, createdAt, provenance,
  evidenceSource: 'actual-native-offline-task-callbacks',
  transport: 'offline-mock', offlineEvidenceOnly: true,
  liveAccepted: false, authenticationVerified: false,
  baselineApproved: false, qualityEvaluated: false,
  contractMatrixComplete: false,
  selection: { cases, clients, arms },
  plannedTaskCount, attemptedTaskCount,
  allReceiptsCompleted: false,
  attempts: [{
    attemptId, task, callbackCount: 1,
    status: 'completed' /* or error, timeout, incomplete */,
    sdkResult: { status: 'passed', duration: 0.123, error: undefined },
    receipt: originalNativeReceipt,
    error: { name, message, code: 'optional', failureClass: 'optional' }
  }]
}
```

Successful rows omit `error`. If the callback/SDK throws before returning,
`sdkResult` is absent and no receipt or native execution ID is manufactured.
An explicitly returned null receipt is retained as null and marked incomplete.
Any returned receipt, even incompatible evidence, is retained by original
object identity for inspection.

Receipt validation checks actual client/version, distinct nonempty native
execution ID, exact task copy, prompt SHA-256, immutable image ID,
`status:'completed'`, required offline/auth/live labels, structured trigger
data, a frozen capture object and host check-outcome structure. Native IDs are
tracked across the current batch, including reported but invalid receipts.
This does **not** authenticate a capture WeakMap handle, establish freshness
against previous invocations, interpret expected skill loading, or grade
correctness/safety. The owning deterministic grader/coordinator must do that.
Failed check outcomes remain in completed callback receipts; SDK `passed` and
`allReceiptsCompleted` mean neither semantic acceptance nor v2 matrix acceptance.

Preflight validation throws exported `TaskMatrixError`. Invalid returned
evidence creates an `incomplete` row with exported `TaskReceiptError` serialized
into `error`. Other callback failures create `error` rows; explicit
`TimeoutError`, `TIMEOUT`/`ETIMEDOUT` codes or `failureClass:'timeout'` create
`timeout` rows. Global SDK provenance/import/registry preflight failures throw
before execution. No aggregate-output cap, external cancellation or new
wall-clock deadline is added.

Test injection uses
`{loadClient: client => ({runOfflineTask: async payload => receipt})}`;
its output is always `evidenceSource:'injected-test-callbacks'`.
There is no automatic persistence. The existing proof script continues to
persist only the old three-client probe route, **not this native task matrix**.
Injected tests establish outer scheduling/capture-identity behavior; actual
generic native task acceptance remains the coordinator/client workers' proof.

Current combined targeted validation:
`node --test C:\Repositories\ai\evals\tests\runner.test.mjs` —
**15 passed, zero failures, one unchanged native-probe test skipped**.
New injected tests cover a complete 54-slot three-client/two-case/three-arm
matrix, 510-slot bounded scheduling, timeout boundaries, raw capture WeakMap
identity, preservation of failed check outcomes, error/timeout/incomplete
continuation, duplicate native IDs, malformed/missing matrix slots, absent
adapters and non-Error failures. No new native task/model/auth calls were made.

## Explicit-host native scheduling ledger

The separate `runNativeTaskMatrix` API is **only a raw scheduling ledger** for
a future admitted native broker. It is not a default live adapter, a provider
API client, an authentication check or an execution authorization mechanism.
Existing offline APIs and their failure semantics are unchanged.

```javascript
import { runNativeTaskMatrix } from './evals/harness/runner/index.mjs';

const ledger = await runNativeTaskMatrix({
  tasks: preparedNativePayloads, // task, prompt, skill, inputs, checks; NO mock.
  timeoutSeconds: 180,
  signal: abortController.signal, // Optional.
  invokeNativeTask: async (payload, { attemptId, signal }) => {
    // Explicit trusted HOST callback; admission/process cleanup belongs here.
    return admittedBroker.invoke(payload, { attemptId, signal });
  }
});
```

`invokeNativeTask` is mandatory; there is no default client/provider/auth route.
The callback receives the copied native payload, including assigned
`timeoutMs`, plus a wrapper UUID and a fresh per-slot AbortSignal. Full checks
remain host callback metadata. Neither checks nor expected values reach any
SDK judge, fixture evaluator, sandbox or model. The broker must independently
keep them outside its native client's model-visible context.

### Admission to scheduling, not admission to live execution

All native data is validated/copied before SDK loading. Top-level options
are exactly `tasks`, `timeoutSeconds`, `invokeNativeTask`, `signal`; task
envelopes are exactly `task`, `prompt`, `skill`, optional `inputs`, and `checks`.
`mock`, protocol-answer fixtures, SDK options, providers, credentials, profiles
and per-task timeout overrides are not accepted. Coordinate/fixture/path/check
validation and exact-three-repeat Cartesian scheduling use the existing
shared scheduler preparation. Invocation IDs come from the tasks.

Additional native-ledger bounds, exported as frozen `NATIVE_LEDGER_LIMITS`:

| Bound | Value |
| --- | --- |
| Tasks / per-slot timeout | 512 / integer 1–300 seconds |
| Skill + input files per task | 64 |
| Each file / prompt | 64 KiB / 64 KiB |
| Checks / check declaration bytes per task | 128 / 64 KiB |
| Payload metadata per task / batch | 1 MiB / 8 MiB |
| Visible receipt metadata per receipt / batch | 1 MiB / 8 MiB |
| Receipt traversal nodes / depth | 16,384 / 16 |

Known instruction/config/plugin/credential/control roots, Windows path
aliases/streams and skill frontmatter execution directives are rejected.
Ordinary nested documents remain data. Inputs must be explicit enumerable
data, not getters/functions or hidden fields; Buffer bytes are separately
copied. These guards are **not an exhaustive client configuration firewall**:
the genuine broker still owns native admission, tool policy and containment.

The public SDK bridge is reused without new per-task registrations.
`runSingleEval` gets one scalar non-model sentinel
`explicit-host-task-callback/not-a-model`, an empty API key and
`validation:'none'`. Its sole action is the supplied host callback.
No SDK config discovery, cache, retry, classifier, sandbox or AI judging occurs.

### Exact ledger shape

```javascript
{
  kind: 'native-task-scheduling-ledger',
  ledgerId, invocationId, createdAt, provenance,
  evidenceSource: 'explicit-host-task-callbacks',
  authenticationVerified: false, liveAccepted: false,
  baselineApproved: false, qualityEvaluated: false,
  contractMatrixComplete: false,
  selection: { cases, clients, arms },
  plannedTaskCount, recordedTaskCount, attemptedTaskCount,
  allReceiptsCompleted,
  counts: { completed, error, timeout, cancelled, incomplete },
  attempts: [{
    attemptId, task, callbackCount, status,
    sourceAudit: { payloadSha256, payloadMetadataBytes },
    elapsedMs, // Present after an invoked callback settles.
    sdkResult: { status, duration }, // If the SDK returned.
    receipt: originalReceipt, // If returned and within evidence bounds.
    receiptAudit: {
      sha256, metadataBytes, captureIdentityRetained, mutationDetected
    },
    error: { name: 'NativeLedgerError', code, message },
    receiptOmitted: true, // Only when receipt evidence is oversized.
    receiptMutationError: { name, code, message } // Additional mutation failure.
  }]
}
```

Optional row fields are absent when unavailable. `recordedTaskCount` counts
every planned slot; `attemptedTaskCount` counts slots entered through the SDK
callback. An already-aborted batch records every slot as cancelled with count
zero, rather than inventing execution. Other failures do not stop later slots.
Wrapper UUIDs never substitute for missing native execution IDs.

Minimal returned-receipt validation requires a plain object with completed
status, matching client/task/prompt hash, a distinct nonempty execution ID and
an original frozen capture object. Optional clientVersion/image metadata is
checked for shape, **not authenticated or compared to a live profile**.
Offline transport/auth labels are not required; arbitrary callback claims of
authentication/live acceptance are preserved only inside the raw receipt and
never promoted to ledger facts.

Receipt descriptors are bounded and hashed without getters or JSON cloning.
Capture identity and all bounded metadata survive. The final in-invocation
audit detects observable receipt mutation; input-byte changes, duplicate IDs,
missing receipts and unsupported metadata become explicit incomplete rows.
Oversized evidence is omitted instead of truncated into a plausible receipt.
Capture WeakMap backing data is not inspected/authenticated by this layer.
Mutations after return cannot be prevented by this raw ledger; the parent must
require authentic immutable broker receipts before grading.

`allReceiptsCompleted` is only structural scheduling completion. It is never
v2 acceptance, real-model provenance or a deterministic correctness result.
There is no automatic persistence or native/client/provider/auth command.

### Sanitized failures and cooperative cancellation

Exported `NativeLedgerError` has stable `name`, `code` and static `message`.
Callback exception names/messages/stack/reasons are never echoed. Codes:
`TASK_MATRIX_INVALID`, `CALLBACK_REQUIRED`, `SIGNAL_INVALID`,
`SDK_UNAVAILABLE`, `CALLBACK_ERROR`, `CANCELLED`, `TIMEOUT`,
`RECEIPT_INVALID`, `RECEIPT_LIMIT`, `DUPLICATE_EXECUTION_ID`,
`RECEIPT_MUTATED`, `PAYLOAD_MUTATED`, `SDK_CORRESPONDENCE`.
Invalid inputs or SDK preflight throw before callbacks; operational failures
are recorded per slot. Raw bounded receipts are host evidence, not sanitized
error strings; the broker must not put secrets into them.

Abort and per-slot deadline request cooperative cancellation through the
callback's signal, using only a static wrapper reason. The scheduler **awaits
callback settlement before another slot**, so a late receipt cannot pass and
no abandoned callback overlaps the next task. Remaining slots after external
abort are explicitly recorded cancelled without invocation.

**Arbitrary JavaScript cannot be force-killed here.** A callback that never
settles can keep this Promise pending beyond its deadline; a synchronous
callback can also delay the event loop. Elapsed time rejects late completion,
but this is not a hard wall-clock containment boundary. The real broker MUST
supervise/terminate its native process and verify cleanup before settling.
No total batch deadline, process containment, turn/token/account/cost limit,
service egress, credentials, model/runtime/image/endpoint profile pins or
baseline approval is enforced or claimed by this SDK layer.

Focused validation uses explicit synthetic host callbacks only; no renewed
native matrix, model/account/auth calls or dependency installation is needed.
The unchanged real offline probe test remains opt-in and skipped for this
continuation.

Final owned targeted validation: **23 passed, zero failures, one unchanged
actual-client probe skipped**. Tests prove original capture/metadata identity,
an 18-slot exact matrix, all-attempt sanitized failures, missing/duplicate/
mutated receipts, private input byte copies, no-mock/control-seed/size rejection,
receipt output caps, mid-flight/pre-abort and cooperative late-receipt handling.
Owned runner module syntax checks also pass. This is synthetic callback proof
only—not a renewed native matrix or genuine broker acceptance.
