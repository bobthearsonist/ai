# Native live execution preparation

`prepare-live` captures the current suite, selected skill/supporting bytes,
context, client/model/service requests, exact profile and candidate/baseline
snapshots. It produces the binding for one fresh three-repeat invocation without
starting a client, logging in, accessing credentials or making model calls.
It does not apply runtime settings or grant execution authority.

```powershell
node harness\cli.mjs prepare-live --suite <suite.json> --profile <native-profile.json> --skill-path skills\example-skill --candidate-export <absolute-export-directory> --baseline-export <absolute-export-directory> --cases explicit --clients copilot
```

Native profiles use `auth: "native-client-auth"`, the implemented public
`@vercel/agent-eval@2.4.1` callback route, exact image/client pins, an explicit
native model identifier and a direct HTTPS service origin. Unverified client
settings overrides are rejected rather than silently ignored. Origin
validation is not service-egress verification or an endpoint override.
Normal supported client account/provider login remains the intended route;
there is no evaluator API key, AI judge or raw API substitute.
Selected live cases must use the implemented deterministic artifact checks.
Trace and manual declarations are rejected during preparation because accepted
trusted adapters are not installed; they cannot trigger account-consuming work
that is already known to be ungradable.

Source limits are 256 files / 1 MiB per task, 64 KiB per prompt, 64 MiB of
source/prompt bytes across the matrix and 512 tasks. Requested limits are at
most 300 seconds, four concurrent sessions, 128 turns and 1,000,000 tokens;
preparation reports all runtime enforcement as **unverified**.

The JSON report contains `planHash`, exact `baselineApprovalTarget` and
`authorizationTarget`. No baseline is auto-approved. An optional
`--baseline <approval.json>` must be an explicit human-approved bootstrap
record binding the exact exported baseline snapshot and profile. A release
reference alone is not release verification. `--invocation-id` can retain an
operator-reviewed identity while regenerating its binding; changed source,
private context, profile or selection changes the plan hash.

Before any account-consuming execution, the native runtime must separately
establish authentic isolated authentication, measured credential/tool and
service-egress boundaries, actual requested limit enforcement and explicit
authorization for that exact invocation. A preparation JSON report, copied
handle or caller assertion cannot supply these proofs.

Native profiles may additionally bind each selected client's final image using
`clients.<client>.runtimeImage: {kind: "local-oci", manifestDigest:
"sha256:<hex>", configDigest: "sha256:<hex>"}`. These are different identity
types: the manifest must reference the actual config and layer blobs; a config
ID is not copied into the manifest field. A locally produced OCI artifact is
not a verified registry manifest. Changing either digest changes the exact
profile, baseline and account-authorization bindings.
Docker's raw image target ID may identify a config or a manifest, depending on
the image store. Its type must be observed and verified; equal digest text is
not a substitute for the exported manifest/config/layer relationship.

For deterministic result compatibility, an explicitly pinned client's
`runtime.image` must equal that config digest and `runtime.runtimeImage` must
match the complete requested local-OCI identity. The shared `profile.image`
remains the legacy/base image pin and never implicitly approves three different
client-built images. Profiles without this optional field preserve their
existing exact image comparison. Offline mock profiles cannot claim native
runtime-image pins. None of these declarations establishes observed image or
live authority without original-handle verification.

## Host API

Import `harness\live-execution.mjs`:

| Function | Behavior |
| --- | --- |
| `prepareLiveEvaluation(options)` | Returns original process-owned `{handle, report}`; validates and copies source/profile/check bytes with no mock answers or credential inputs. |
| `describeLiveEvaluation(handle)` | Returns an independent report copy and rechecks any explicit account approval's expiry; execution/auth/containment/limit/live authority remains false. |
| `authorizeLiveEvaluation(handle, record)` | Binds one externally supplied, exact, expiring human account-consumption record; does not start execution or verify enforcement/authentication. |
| `readLiveTaskRequest(handle, index)` | Returns independent task/input/skill/check copies for the trusted host executor. Checks are host metadata, never model wire input. No-skill slots contain no target bytes. |
| `prepareLiveNativeToolWorker(handle, index, {limits?})` | Creates an original worker from only that task's captured public skill/context bytes and artifact target strings; returns `{worker, report}` without starting Docker or a native client. |
| `await startLiveNativeToolWorker(worker, {signal?})` | Starts that original worker, leases its transport once, resolves and freshly asserts the original binding; returns `{toolTransport, report}` with no native/authentication/discovery authority. |
| `describeLiveNativeToolTransport(toolTransport)` | Requires the original host-issued tuple and evaluation/index binding; checks original worker identity, expiry and captured public-file/target metadata without kernel I/O. |
| `await inspectLiveNativeToolTransport(toolTransport, {signal?})` | Freshly asserts the original worker kernel boundary and rechecks host lifecycle; never claims a verified native consumer, authenticated custody or Skill loading. |
| `await captureLiveNativeToolArtifacts(toolTransport, {signal?})` | Once per original worker, verifies its original artifact capture and exact target/byte identities, stages only those bytes in an owned host workspace, creates an original immutable host capture and grades private checks. Returns `{capture, grading, report}` with native/auth/discovery/live authority false. |
| `await releaseLiveNativeToolWorker(worker)` | Closes only that original host-owned worker; the caller must first remove any exact native consumer that still mounts its socket volume. Failed cleanup retains recovery ownership. |
| `assessLiveTaskAdmission(handle, index)` | Rechecks the original evaluation and current approvals; returns explicit per-task native runtime, image, custody, egress, hard-policy and supervision failures. No caller assertion can grant admission. |
| `prepareLiveNativeTask(handle, index, {boundary, candidate, custody, toolTransport?})` | Binds original process-owned, active nonfixture boundary/candidate and exact evaluation/client custody; an optional original tool transport must bind that same evaluation/index. Returns the original client specification plus an independent planning report, not execution authority. |
| `describeLiveNativeTask(specification)` | Requires that original unchanged specification, rechecks its evaluation/custody/boundary lifecycle and returns an independent planning report. |
| `await inspectLiveNativeTaskRuntime(specification, {imageHandle, manifestObservation?})` | Requires the original prepared specification and client-owned native image handle; freshly inspects its original native candidate and rechecks lifecycle. An optional original manifest observation can verify the captured per-client local-OCI pin, not registry provenance, authentication or execution. |
| `releaseLiveEvaluation(handle)` | Requires all its owned tool workers to be released first, then clears task buffers and invalidates that original handle; removes no caller files, exports, accounts or global state. |

Grader-private dependencies affect the binding but are excluded from native
mounts and public approval descriptions. Original CRLF/LF bytes and hashes are
preserved. These APIs do not serialize live authority or accept mocked
authenticated receipts.

## Captured public tool transport

The host can prepare a worker for one exact planned task. It passes only
`{path, content}` files under `skills/<skill-id>/<relative-path>` and
`inputs/<mounted-relative-path>`, plus target strings under
`artifacts/<declared-target>`. Grading declarations, private dependencies,
expected answers, credentials and caller-selected host paths are excluded.
The no-skill arm has no selected skill files. Original source bytes and hashes
are retained; temporary host copies are zeroed after preparation.

Worker limits can only be narrowed. Its timeout is bounded by both the captured
native timeout and the worker's 60-second cap, including startup. This is a
separate tool-worker lifetime, not proof of native task or account limits.
Source/target limits remain 32 files, eight targets, 16 KiB per public file and
128 KiB total source bytes; larger tasks fail explicitly rather than bypassing
the worker.

Startup returns an original frozen `{task, worker, lease, binding}` tuple.
Copies, serialization, a separately issued tuple, another evaluation or
another task index cannot be adopted by the host native bridge. The binding
contains the original fixed MCP shim command, readonly socket volume and
absolute transport policy; descriptive reports omit its raw command and scope
nonce. Activity cannot renew its deadline. Synchronous description is
identity-only; asynchronous inspection verifies the worker boundary, not a
native client's use of it.

Cleanup ordering is native consumer, tool worker, then evaluation. A stopped
but unremoved consumer still owns a volume reference. Worker cleanup must not
remove foreign consumers to make its volume removable. Startup failure awaits
owned cleanup; a cleanup failure remains explicit and retains the original
worker for recovery. Transactional preparation failure likewise retains an
issued `error.worker` when rollback could not finish.

The host artifact API preserves the worker's ordered UTF-8 JSON capture hash;
it is not the canonical host capture identity. Task/source bindings, every
declared present or missing target, exact content hashes and the narrowed
artifact byte cap are checked before host staging. Host grading uses the
original trusted in-process capture and never sends private check declarations
or expected answers to the worker. Every host-captured hash, byte count and
present/missing state must still match the verified worker result before any
check is graded. Staging is removed after immutable capture;
cleanup failure returns the original owned `error.workspace` for explicit
recovery. Private byte/metadata copies retain the verified snapshot across
asynchronous worker inspection. Decoded worker buffers and private byte copies
are zeroed after host copying, including failure paths. Failed or concurrent
capture cannot retry that worker.

Quiesce the producer and remove its exact native consumer before capturing and
persisting worker artifacts, then close the worker before its absolute
deadline. Clean MCP EOF preserves the ready worker/admin channel without
renewing expiry. Expiry, fatal worker failure or worker close prevents capture;
there is no archival recovery.

These APIs do not provide a native executor. Worker artifact grading alone
does not establish native-client consumption, completed Skill discovery, model
execution, authenticated custody or live acceptance. Native routing,
consumer supervision and full native evidence remain separate admission gates.

## Persistent fail-closed dispatch

`harness\live-case-execution.mjs` exposes
`executeLiveCaseMatrix(originalEvaluation, {signal?})` and
`persistLiveCaseMatrix(originalMatrix)`. `run-live` accepts the same explicit
source, profile and approval options as `prepare-live`, then uses the pinned
public SDK to visit every planned host callback and persists each admission
failure. It exits nonzero while any native requirement remains unresolved.
No injected executor, credential, model, limit waiver or admission proof is
accepted.

The output is `native-live-dispatch-diagnostics`, **not native task execution
or a completed evaluation**. A fresh SDK attempt ID identifies a host
scheduling attempt, not a native session. `hostCallbackCount` is separate from
`attemptedTaskCount` and `nativeDispatchedTaskCount`, which remain zero.
Execution IDs, observed models, native usage and artifact captures remain
null; unexecuted checks are errors, never passes. Cancellation also retains
every planned coordinate without exposing the cancellation reason.
Three four-case pilot selections produce 216 diagnostic coordinates with
three clients, two arms and three repeats. These remain host admission records,
not 216 native sessions or completed checks.

Private inputs, answer keys and source bytes do not enter persisted diagnostic
reports. Only the original matrix can be persisted, and caller edits to its
public report cannot alter the internal evidence. Each original evaluation
enters dispatch at most once. Evidence is written through the existing owned
workspace API; no foreign workspace, source, credential or shared cache is
removed.

## Native task preparation bridge

The host bridge invokes the implemented Claude Code, Copilot CLI or OpenCode
native specification builder directly; there is no injected executor or model
callback. It passes only captured task coordinates, exact prompt/skill/context
bytes and deduplicated artifact **target strings**. Host checks, expected
answers, grader-private bytes and offline mock scenarios do not enter the
specification. The selected model and planned timeout come from the captured
profile; Claude also receives its scoped `maxTurns` plan from the captured
turn limit. This hidden pinned native main-loop counter is supported but not
applied by preparation, and does not bound aggregate tokens, retries or charge.
Configuration-root and CONNECT-proxy locators come only from the
original candidate. OpenCode model pins must use its native `provider/model`
syntax. Each client's narrower source/format caps still apply.

The boundary's policy hash must match the exact service hostnames selected by
the preparation. Identity checks alone are insufficient: fixture-only, expired,
stopped, failed or transitional candidates are rejected. The absolute shared
deadline is bound, but the boundary API does not expose its original timeout;
preparation does not claim time enforcement. Custody assertion checks its
owned empty staging and evaluation binding, not authenticated account storage.
Optional tool transport must be present on both the original candidate and the
host specification. Its task, source and transport-binding hashes must match
before any client builder runs; a transport-attached candidate cannot silently
use a default unconfigured specification. Cached matching metadata does not
replace fresh runtime assertion of all original transport references.

Keep the returned **original specification** for its client observer and
`describeLiveNativeTask`; serialized or cloned specifications are not handles.
Releasing the evaluation invalidates its bridge specifications but does not
stop externally owned boundaries or release custody. The host must separately
clean up those originals.

The pure preparation/description reports keep all admission flags false.
The boundary separately supports original native image adoption through
`prepareNativeEgressCandidate`; the legacy Node-only candidate is not a native
runtime. The host can call `inspectLiveNativeTaskRuntime` for a specification
bound to an attached native candidate, retaining its original client image
handle. It freshly checks image authority, native version/package/executable,
UID/GID, working directory, network-policy binding and observation timestamp,
then rechecks the evaluation, custody, candidate and boundary lifecycle.
The pinned Copilot runtime requires UID/GID `10001:10001`; Claude Code and
OpenCode require `1000:1000`. A different client's non-root identity is not
accepted as an equivalent runtime.

That separate observation can report `nativeRuntimeVerified` and
`nativeImageAttached` true, **only for credential-free version/help attachment**.
It records the measured Docker image target ID without treating its text as
manifest authority. Without a separate original manifest observation,
`imageMatchesProfile` remains null and `requestedImageVerified` false.
With `manifestObservation`, the host requires the observer's original handle
bound to the same original client image and rechecks its authority before and
after asynchronous candidate inspection. Only exact matches to the captured
per-client manifest **and** config digests set those image-pin flags true.
A mismatched pin is explicit; a missing per-client pin remains unverified.
The returned `runtimeManifestObservation` is an independent descriptive copy,
not a handle or remote registry verification. The shared image pin never
implicitly approves three different client-built images.
Retain the original observation and client image handles until their dependent
work is finished. Diagnostic digests from a released observation or removed
image cannot be reused as current authority, even if they match a profile.
Observed model/usage remain null. Authentication, task execution, service-only
provider compatibility, effective turn/token/account limits and live acceptance
remain false. Neither the original preparation nor later descriptions are
silently promoted by an inspection result. Copied or serialized reports confer
no runtime authority.

These APIs are **not a live executor**. Module-mocked boundary doubles exercise
bridge and inspection wiring in units only and are not containment or native
acceptance evidence. Real credential-free attachment evidence belongs to the
boundary's separately measured checks.

The opt-in host-to-original-candidate regression runs only native version/help
inspection for all three clients and verifies exact owned cleanup:

```powershell
$env:SKILL_EVAL_NATIVE_RUNTIME_INTEGRATION = '1'
node --test tests\native-task-runtime.test.mjs
```

It makes no login/status/model/account calls and does not replay the offline
matrix. Its original empty custody and profile deliberately remain unadmitted.

## Verified native feasibility blockers

The exact pinned native interfaces do not establish the requested cross-client
hard aggregate input+output task-token or account-charge guarantees.
Claude 2.1.291 has a hidden scoped `--max-turns` terminal counter; its
`--max-budget-usd` is a post-response list-price guard, not hard prespend
enforcement. OpenCode 1.14.28's `agent.steps` adds a model instruction rather
than an unconditional dispatch stop, and its outer processor retries have no
attempt ceiling. Copilot 1.0.92 continuation limits are not agentic-turn limits;
documented credit controls are soft and exact-pin scope remains unverified.
Native counters and estimates do not prove provider quota or actual account
charges. See the [Claude native limit scope](clients-claude-code.md) and
[native credential broker prerequisites](auth.md).

Independent credential/tool separation also remains unresolved: shell
sandboxing does not protect all native file tools, and software permission
rules are not an independently measured credential boundary. Normal native
login/status/refresh has not been executed. Preparation, runtime attachment
and declared account approval cannot bypass these failures. An unsupported
hard-policy requirement must reject execution before provider dispatch;
changing that policy requires explicit human authorization.

## Exact account authorization

An optional `--authorization <approval.json>` binds a human-supplied record to
the exact `authorizationTarget` emitted for the same `--invocation-id`.
Its fields are `contractVersion: 2`,
`kind: "native-account-consumption-authorization"`, `target`, `approval` and
`consumption`. `target` must equal the complete emitted target, including
sources, native routes, selected slots and requested limits. `approval` has
`approved: true`, a named `by`, canonical UTC `at` and `expiresAt`; the approval
must be current and expire within 24 hours.

`consumption` contains exactly the selected clients. Each entry has a nonsecret
`account` label, `unit` (`usd`, `native-nano-aiu` or `provider-requests`), a
positive finite `maximum` and the exact number of planned `sessions` for that
client. Non-USD units require safe integers; nano-AIU is Copilot-specific.
Do not put account identifiers, credentials or tokens in this record.

These are declared operator ceilings, **not evidence that a client can enforce
them**. Account authorization can become true while authentication, containment,
requested turn/token/time/concurrency limits, consumption enforcement and live
acceptance remain false. Expiry is rechecked whenever the process-owned
preparation is described. Changing a source, route, limit or slot invalidates
the binding; copied/released handles and rebinding are rejected. The tooling
does not write an approval, infer it from conversation, authenticate the human
author or turn a CLI JSON report into reusable runtime authority.
