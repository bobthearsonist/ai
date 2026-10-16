# Local TLS service-egress boundary

`harness/live-boundary/index.mjs` implements a **network enforcement component**
with an additive credential-free native-image attachment preflight, not a model
gateway, authentication lease, task runner, or live-admission verifier.
It neither decrypts TLS nor changes provider endpoints, provider
authentication, application payloads, or client trust stores.

**Live remains unsupported.** `mode: 'live'` fails synchronously with
`LIVE_BOUNDARY_UNVERIFIED`, before Docker is invoked. This component does not
modify existing isolation, authentication, runner, schemas, CLI, or client adapters.

## Public process-owned API

```js
import {
  startEgressBoundary,
  describeEgressBoundary,
  stopEgressBoundary,
  runLocalEgressBoundaryLab,
  prepareEgressCandidate,
  describeEgressCandidate,
  assertEgressCandidate,
  attachEgressCandidate,
  inspectEgressCandidate,
  stopEgressCandidate,
  prepareNativeEgressCandidate,
  assertNativeEgressCandidate,
  inspectNativeEgressCandidate,
  EgressBoundaryError
} from '../harness/live-boundary/index.mjs';

const handle = await startEgressBoundary({
  hosts: ['api.example.com'], // Illustrative policy identity, not service approval.
  timeoutSeconds: 120,
  mode: 'egress-only',
  signal: optionalAbortSignal
});
try {
  const observation = describeEgressBoundary(handle);
  // Do not run a native login or model task on the strength of this observation.
} finally {
  const cleanup = await stopEgressBoundary(handle);
}
```

* `startEgressBoundary({hosts, timeoutSeconds, mode, signal?})` validates arguments
  synchronously, then returns a Promise of a frozen handle authenticated by a
  module-private WeakMap. Mandatory timeout is an integer from 5 through 300
  seconds; the whole setup/measurement/service lifetime shares that deadline.
  `mode` must be explicit: `egress-only` or the always-rejected `live`.
* `describeEgressBoundary(handle)` synchronously returns a deeply frozen
  timestamped observation: policy hash, actual runtime and network facts,
  internal proxy URL, client network/DNS arguments, classification, and lifecycle.
  It is **not ongoing attestation**. The measured subject is the owned Node probe,
  or the exact replacement network-only candidate controller, not any native
  executable. Client arguments are a description, not
  authorization to attach another container.
* `stopEgressBoundary(handle)` returns a Promise of verified exact cleanup.
  Successful stopping is idempotent. It validates captured identities, labels,
  marker hash, attachments, and filesystem provenance, then verifies that each
  exact container/network no longer exists and closes attached helper processes.
* `runLocalEgressBoundaryLab({timeoutSeconds, signal?})` returns a frozen
  **historical fixture-only report after cleanup**, never a reusable handle,
  authentication lease, or admission receipt. It accepts no hosts, addresses,
  image overrides, fixture boolean, or credential input.

Cloning, JSON serialization, fabricated observations, names, and booleans cannot
create a handle. There is no API accepting an external Docker resource as proof.
The policy host list expresses requested routing identities only: service
approval, credentials, authentication, tool confinement, and authorization must
be independently established. Boundary and default network-only candidate
descriptions report:

```text
publicServiceEgressVerified: false
credentialIsolationVerified: false
authenticationVerified: false
toolIsolationVerified: false
authorizationVerified: false
liveAccepted: false
nativeRuntimeVerified: false
nativeLimitsVerified: false
providerQuotaVerified: false
billingVerified: false
```

`networkIsolationVerified` means the timestamped owned-probe measurements passed.
It does not override those false fields or the unconditional live guard.
The additive native candidate can report a scoped, timestamped
`nativeRuntimeVerified: true` only after actual version/help measurements.
Every other admission/authentication/limit flag above remains false.

### Original candidate attachment and lifecycle

```js
const candidate = prepareEgressCandidate(boundaryHandle, { client: 'opencode' });
const issued = describeEgressCandidate(candidate);
// A trusted broker may stage permitted public SDK/input/settings files in
// issued.staging. Do not copy credentials, personal HOME, or auth custody here.
await attachEgressCandidate(candidate);
const binding = assertEgressCandidate(candidate, {
  boundary: boundaryHandle,
  client: 'opencode'
});
const freshNetworkObservation = await inspectEgressCandidate(candidate);
// No native invocation, image adoption, credential attachment, or admission.
const cleanup = await stopEgressCandidate(candidate);
```

* `prepareEgressCandidate(originalBoundary, {client})` **synchronously** issues a
  frozen null-prototype `{id, kind: 'process-owned-egress-candidate'}`. The active
  boundary must be original and measured; exactly one candidate slot is allowed
  for its entire lifetime. Client is exactly `claude-code`, `copilot`, or
  `opencode`. This only binds the intended client identity and expected version.
  It does not install, observe, run, or authenticate that client.
* `describeEgressCandidate(originalCandidate)` synchronously returns the frozen
  description below. Public staging paths are newly UUID-issued directories,
  not personal configuration or credential-custody paths. After attachment the
  source inventory is sealed and readonly mounted only into this candidate.
* `assertEgressCandidate(originalCandidate, {boundary: originalBoundary, client})`
  verifies the **original handle identities**, exact boundary/client binding,
  and owned marker, then returns the description. A different genuine boundary,
  a cloned handle, copied labels, and an altered client cannot rebind the slot.
  This is an ownership/binding verifier, **not fresh Docker inspection**, SDK
  provenance, or an authentication verifier.
* `attachEgressCandidate(originalCandidate)` returns a Promise of the **same**
  genuine candidate handle. It accepts no options, Docker ID, image handle/tag,
  mount/profile paths, environment, proxy override, proof callback, or boolean.
  It seals staging, performs exact topology preflight, stops/removes the original
  probe and closes its own attach helper, then creates an owned replacement on
  the same isolated internal network. It measures the replacement's actual
  confinement/runtime/DNS/routes and repeats the denial probes.
* `inspectEgressCandidate(originalCandidate)` returns a Promise of a fresh frozen
  description after exact container/network/configuration inspection and a
  trusted read-only Node controller's fresh kernel/resolver observations. It
  does not trust the guest-writable readiness JSON after attachment. Negative
  probes are retained with their separate `negativeProbesMeasuredAt` timestamp,
  **not represented as rerun**. Inspection failure invalidates the observation
  and invokes exact cleanup; an ownership conflict can retain a genuine recovery
  handle and `cleanupVerified: false`.
* `stopEgressCandidate(originalCandidate)` returns the same cleanup receipt as
  stopping its **whole bound boundary**, not merely one container. The retired
  probe, replacement, relay, fixture if any, networks, owned staging, and helper
  processes are accounted for. Successful stopping is idempotent. Stop/abort
  during attachment cancels bounded work and waits for its exact cleanup; it
  never starts a second competing creation/cleanup lifecycle.

Staging rejects root-area and nested symlinks, hardlinks, special files, unsafe
Windows aliases/names, unexpected entries and inventory changes after sealing.
Limits are 4,096 files, 4,096 directories, 512 MiB total, 256 MiB per file,
depth 16 and relative path length 1,024. Only counts/bytes/aggregate hash are
published. SDK `.bin` symlinks must not be staged as symlinks.

The default replacement still uses **exact `OFFLINE_NODE_IMAGE`**, not a derived native
SDK image or an adopted caller container. It runs only the owned idle Node
controller. No API executes a native command. Authentic runtime-image authorities
from client modules are accepted only by the separate native API below.
Merely staging files or selecting a client name cannot establish native authority.

### Additive original native-image attachment

```js
// imageHandle must be the ORIGINAL active handle returned by this client's owner.
// This does not acquire credentials or authorize a task.
const candidate = await prepareNativeEgressCandidate(boundaryHandle, {
  client: 'claude-code',
  imageHandle
});
await attachEgressCandidate(candidate); // Same original-handle lifecycle as above.
const binding = await assertNativeEgressCandidate(candidate, {
  boundary: boundaryHandle,
  client: 'claude-code',
  imageHandle
});
const fresh = await inspectNativeEgressCandidate(candidate);
await stopEgressCandidate(candidate);
// Release imageHandle separately through its ORIGINAL client cleanup helper.
```

* `prepareNativeEgressCandidate(originalBoundary, {client, imageHandle, toolTransport?})` returns
  a Promise of the same kind of original candidate handle. Options must contain
  exactly those two own data properties, optionally plus the original transport
  tuple described below. Omitting the tuple preserves the existing API,
  configuration, reports and whole-boundary lifecycle. The three admitted image issuers are
  Claude `prepareNativeImage`, Copilot `buildNativeImage`, and OpenCode
  `prepareNativeRuntimeImage`. Their process-private original-handle
  describe/assert APIs are called directly; the original image handle is retained
  in the candidate's private state. Cross-client handles, DTOs, tags, image/container
  IDs, callbacks, booleans, profile/auth paths and environment overrides are rejected.
  No caller-supplied observation substitutes for the issuer's authority.
* Preparation re-inspects the issuer's **immutable image ID**, exact owner label,
  Linux/amd64 platform, image user/workdir/entrypoint and credential-free image
  environment. `imagePreparation` is this timestamped image inspection plus
  fixed preparation requirements; it does **not** observe a running native CLI.
  `imageAuthority` describes retained lineage, but is not transferable authority.
* `attachEgressCandidate(originalNativeCandidate)` reasserts active original image
  ownership and fresh immutable identity, retires the original Node probe, then
  creates an owned candidate on that **same measured internal network and relay**.
  Docker creation uses the immutable image ID, `--pull never`, exact native UID,
  readonly rootfs, fixed native HOME/config/cache/workdir layout, and fixed
  controller entrypoint; it never executes a baked offline/mock entrypoint.
  Native limits are 768 MiB memory/swap, one CPU, and 64 PIDs (96 for Copilot).
  Native `/workspace` or `/work` tmpfs is 256 MiB; other roots remain 16 MiB,
  noexec/nosuid/nodev/mode 700 and owned by the native UID/GID.
* The readonly controller invokes **only the fixed native executable's
  `--version` and `--help`** (Copilot also receives `--no-auto-update`).
  Fresh observations include actual CLI/package and Node versions, process
  UID/GID, resolved executable/hash, native directory ownership/access, and
  successful command exit states/output hashes/byte counts. The native
  executables are Claude 2.1.291 `/opt/client/node_modules/.bin/claude`,
  Copilot 1.0.92 `/opt/fixture/node_modules/.bin/copilot`, and OpenCode 1.14.28
  `/opt/client/node_modules/opencode-linux-x64/bin/opencode`.
  Claude/OpenCode use UID/GID 1000; Copilot uses 10001. OpenCode's initial cwd is
  `/opt/fixture`, with task cwd `/work/project`; Claude/Copilot start in `/workspace`.
  Copilot retains its image's public readonly `/opt/copilot-cache/.cache`,
  with separate writable `/client-config/xdg`, `/client-config/data`,
  `/client-config/state` and `/client-config/copilot`.
* Each command has a 20-second maximum **clamped to the original boundary
  deadline**, 128 KiB combined stdout/stderr, ignored stdin, and exact child
  termination supervision. Boundary abort/expiry stops the exact owned container
  and helpers; stop during native preparation, attachment or inspection waits
  for that operation's cleanup. These are process/resource limits, not native
  model turn/token/account enforcement.
* `assertNativeEgressCandidate(originalCandidate,
  {boundary: originalBoundary, client, imageHandle: originalImageHandle, toolTransport?})` returns
  a Promise of the description only after exact original-handle binding, active
  issuer authority, active attached lifecycle and a completed native measurement
  are checked. **It does not refresh Docker/kernel/CLI measurements.**
  Use `inspectNativeEgressCandidate(originalCandidate)` for those fresh facts.
  Both APIs reject legacy network-only candidates as native authority.
  The general `inspectEgressCandidate` also selects the native measurement path
  for an original native candidate.
* Inspection freshly checks original issuer activity, immutable image metadata,
  exact owned Docker topology/configuration, kernel routes/DNS/IPv6 and actual
  native version/help/executable/layout. Descriptions remain **timestamped
  observations, not ongoing attestation**. `nativeRuntime.image.inspectedAt`,
  `nativeRuntime.measuredAt` and `observed.measuredAt` identify the separate
  measurement instants. Inherited denial evidence remains explicitly timestamped
  by `negativeProbesMeasuredAt` and attributed to the **original measured Node
  boundary probe**; the settled relay denial lab is not replayed as native proof.
* The native executable is never masked by staging: its native runtime staging
  area must remain empty and is mounted at `/candidate-runtime`, not `/opt/client`
  or `/opt/fixture`. Only explicitly selected public task/policy bytes may be
  placed in `inputs`/`settings`. Known credential and private-grading paths are
  rejected in files **and directories**. Nothing imports personal configuration,
  credentials, host grading data or an auth lease. This path guard does not
  classify arbitrary byte contents or replace the parent exporter's public/private
  source selection. No staged task is dispatched by this API.
* `nativeRuntimeVerified` means only that this native executable/layout and
  version/help observation passed on the owned container. Observed model and usage
  remain **null**. Public provider success/proxy compatibility, authentication,
  credential/tool isolation, authorization, live acceptance, native model limits,
  provider quota and billing stay false/unverified. Boundary-level descriptions
  remain network-only. Neither an image preparation DTO nor the retained JSON
  evidence can unlock `mode: 'live'` or authenticated admission.
* Candidate cleanup removes only its owned boundary containers/networks/staging/
  helpers; it **borrows** the native image authority and never deletes that image.
  The caller must subsequently use the exact client-owned image cleanup helper.
  Shared pinned base images are preserved.

### Optional original isolated tool-worker socket composition

```js
// Each tuple member is the ORIGINAL reference issued by the tool-worker owner.
// A new frozen outer tuple is allowed; cloned/serialized members are not.
const toolTransport = Object.freeze({ task, worker, lease, binding });
const candidate = await prepareNativeEgressCandidate(boundaryHandle, {
  client: 'claude-code', imageHandle, toolTransport
});
await attachEgressCandidate(candidate);
const asserted = await assertNativeEgressCandidate(candidate, {
  boundary: boundaryHandle, client: 'claude-code', imageHandle, toolTransport
});
const inspected = await inspectNativeEgressCandidate(candidate);
// Neither report authorizes native MCP discovery, a model task or authentication.
```

The tuple must be a plain, non-proxy object with exactly four own data properties:
`task`, `worker`, `lease`, `binding`. The boundary snapshots those four original
references privately, verifies the original task/client/lifecycle/absolute expiry
through `describeToolWorkerTransportBinding`, and calls the owner's
`assertToolWorkerTransportBinding` for fresh authority before and after asynchronous
preparation, attachment and inspection. No copied description, returned JSON,
Docker ID/volume, group option, command, environment or caller proof can substitute.
The task hash, source hash, original binding reference, protocol, original deadline,
fixed worker program and fixed shim hashes must all agree.

`assertNativeEgressCandidate` **requires** the expected tuple for a transport-bound
candidate and compares all four references with its private tuple before fresh
worker checks. A different genuine tuple is denied even when task coordinates,
client and source bytes/hashes match. Omitting it, or requesting transport on a
candidate prepared without transport, is denied with `TOOL_TRANSPORT_SCOPE_MISMATCH`;
there is no silently ignored expectation. Assertion refreshes original worker and
image authority, **not the native consumer's earlier Docker/kernel measurements**.
Use `inspectNativeEgressCandidate` to refresh those measurements. Descriptions are
timestamped observations, not transferable authority or ongoing attestation.

Composition adds only the original socket-only named volume at `/tool-rpc`,
readonly with `volume-nocopy`, and exactly supplemental GID **21000**. Docker
inspection checks actual volume type/name/destination/RO, requested
type/source/target/RO/NoCopy, and the exact supplemental group. Copilot's primary
identity stays **10001:10001**; Claude/OpenCode stay **1000:1000**. Existing immutable
image/owner/network/policy checks, readonly public/controller mounts, empty native
custody and fixed environment remain in force. The added readonly Node probe
checks the consumer's primary/supplemental identities and the sole original socket's
type, owner and permissions (`10002:21000`, directory `0710`, socket `0660`).
It **does not connect**, consume the one connection, or execute the MCP shim.

The original binding's immutable `stdioCommand` is checked against the fixed
env-cleaning inline shim contract and its full-source hash. It is neither executed
by this component nor recreated/substituted as a shim file, mount or credential
environment. The worker/shim absolute deadline is unchanged (default 60 seconds,
including worker startup); the consumer inherits the earlier of that deadline and
the boundary's existing deadline. No attachment, inspection, idle interval,
connection or retry resets time or budgets. Idle beyond ten seconds is not a new
timeout policy; the original single-connection/no-reconnect contract is unchanged.

New optional candidate fields:

* `toolTransport.kind: 'original-native-tool-worker-socket-attachment'`;
  `protocol`, `task` coordinates, `taskHash`, `sourceHash`, `publicFiles` metadata,
  declared `artifactTargets`, `limits`, `deadlineUnixMs`,
  `transportBindingHash`, `workerProgramHash`, `shimHash`.
* `toolTransport.plannedAttachment`: `type`, **hashed** `volumeSourceHash`,
  `target`, `readOnly`, `noCopy`, `socketPath`, `supplementalGid`, `primaryUser`.
  No raw volume nonce, binding/shim/argv, worker host path or credential is added
  to this report.
* `originalAuthorityRetained: true`, `authorityTransfer: false`,
  `planningOnly`, `attachmentVerified`, `freshKernelVerification`, `verification`,
  `evidenceScope: 'kernel-socket-composition-only'`, and `cleanupOrder`.
  Verified fields describe only the timestamped completed composition.
* `toolTransport.observation`: `measuredAt`, `workerVerifiedBefore`,
  `workerVerifiedAfter`, `containerId`, measured `mount`, consumer `socket`
  facts; `connected: false`, `shimExecuted: false`.
  The same safe observation appears at `observed.toolTransport`, and measured
  mount metadata at `observed.container.toolTransport`.
* Candidate `effectiveDeadlineUnixMs` and `expiresAt` use the earlier deadline.
  `nativeRuntime.supervision.inheritedExpiresAt` reports that same bound.

`nativeAdmissionSupported`, `nativeConsumptionSupported`,
`consumerSupervisionSupported`, `nativeDiscoveryVerified`, `skillDiscoveryVerified`,
`authenticationVerified`, and `liveAccepted` remain **false** on the transport report.
Existing credential/tool isolation, native model/account limits, quota, billing
and live gates also stay false. Existing `nativeRuntimeVerified` may still reflect
the separate version/help preflight, never socket/MCP/Skill/model/authentication
proof. Worker-only success cannot promote those gates. The kernel composition API
does not establish that any client's pinned configuration safely discovers this
MCP server or confines native tools; client builders must independently fail closed.

#### Consumer cleanup and artifact capture order

The worker has **no native-consumer registration/removal API**. A stopped but
unremoved native container still holds the volume in use. On transport failure,
expiry or boundary cancellation, the boundary awaits removal of its exact owned
consumer and whole-owner cleanup. It never deletes the worker container, borrowed
volume or a foreign consumer. Failed cleanup returns an explicit infrastructure
failure and retains the original `recoveryHandle`, `failureCode` and
`cleanupVerified: false`; recover through the original boundary before worker
release. Boundary cancellation is not forwarded into a fresh worker assertion:
that would let the borrowed worker close before its consumer was removed.

Safe ordering for an eventual native executor is:

1. Finish/quiesce the native MCP producer **before the original deadline**.
2. Await `stopEgressCandidate(candidate)` (or whole-boundary stop) and verify
   `cleanup.toolTransportConsumer.exactConsumerAbsent === true`.
3. Capture declared worker artifacts while the original worker remains ready
   and unexpired; budget consumer cleanup plus capture inside that deadline.
4. Only then close/release the **original** worker and subsequently its other
   original host/image owners. Persist the captured bytes through the original
   HOST artifact/capture/grading path; do not assume client-local files exist.

The optional cleanup receipt includes `toolTransportConsumer` with
`candidateId`, `containerId`, `transportBindingHash`, `exactConsumerAbsent`,
`workerContainerRemoved: false`, `workerVolumeRemoved: false`,
`originalAuthorityRetained: true`, and `requiredCleanupOrder`.
Worker automatic expiry/cancellation/fatal transport failure can race this order;
coordinated consumer supervision remains unsupported. If worker volume cleanup
failed while the consumer existed, remove the original consumer first, then retry
worker cleanup through its original owner. No recovery may adopt another handle
or remove a foreign volume consumer.

From the public worker implementation, a **clean native MCP socket EOF alone does
not close the worker**: it removes that socket, preserves the host-admin stdin
channel and filesystem, and permanently rejects reconnection. Therefore
`captureToolWorkerArtifacts({task, worker, signal?})` can capture before or after
clean MCP connection completion, while the original worker is ready and unexpired.
Capture while the producer is still active is only a snapshot; later writes can
change outputs. The capture API fresh-checks the original worker, reads only
declared targets over the separate admin channel, and returns `artifacts` containing
`path`, `bytes`, `sha256`, **Buffer `content`**, plus `missing`, `task`, `taskHash`,
`sourceHash`, `captureHash` and the permanently false worker evidence flags.
Capture still needs remaining control/admin/output budget; no reserved final-capture
budget or transactional native-finish-and-capture API exists. Serialize HOST admin
operations, await completed native writes, and treat missing targets or capture
failure as actual outcomes rather than assuming all declared outputs are present.

`captureHash` uses the worker's `hashJson` (**SHA-256 of UTF-8 `JSON.stringify`,
not the harness's key-sorting/canonical-object hash**):

```js
sha256(JSON.stringify({
  taskHash: capture.taskHash,
  artifacts: capture.artifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  missing: capture.missing
}))
```

Preserve the returned array order and the shown object-key order. `content`
buffers/base64, `sourceHash`, task coordinates, limits and evidence flags are
**not** part of this hash; artifact content integrity is represented by each
artifact's SHA-256. Fresh original task/source authority is checked separately.

The API also permits capturing a quiesced producer's outputs **before** consumer
removal if needed to retain bytes ahead of cleanup's deadline cost. Consumer
removal does not itself close the worker or its separate admin channel. The strict
ownership requirement is removal **before worker close**, not an invented
registration dependency on capture. Either capture order still requires a ready
unexpired worker and completed producer writes; consumer removal/clean MCP EOF
does not reserve or extend any capture window.

Worker/broker stdin EOF, truncated/error transport, fatal limits, cancellation,
deadline expiry or explicit close may destroy its tmpfs and remove access.
**Post-close/post-deadline capture is unsupported; there is no archival or salvage
API.** Successfully returned capture buffers can be retained by HOST, but closing
first and trying to capture later cannot recover them. Host-native integration
must export those actual buffers to original declared HOST targets before release,
not grade fabricated/native-local artifact placeholders.

#### Validation and remaining proof

`live-boundary-native-transport.test.mjs` adds unit/interface regressions for exact
tuple identity (including different originals with identical task/source hashes),
mutable outer tuple snapshotting, fresh pre/post authority, all fixed primary
identities, RO/NoCopy/group/socket drift, released images, expiry/cancellation,
exact consumer removal before worker release and failed-cleanup recovery.
Its VM ports are **unit wiring only**, not Docker/native/model evidence.

Focused Windows validation (27 passing tests, including 22 VM lifecycle/identity
scenarios inside the five new transport tests; opt-in real labs are excluded):

```powershell
node --test --test-reporter=spec `
  --test-name-pattern='wiring-only|candidate|staging|ownership|external attachments|unstarted|absence|confinement|native-labelled|Docker environment|readiness|finite helpers|process-owned handle|public arguments' `
  'C:\Repositories\ai\evals\tests\live-boundary.test.mjs' `
  'C:\Repositories\ai\evals\tests\live-boundary-native.test.mjs' `
  'C:\Repositories\ai\evals\tests\live-boundary-native-transport.test.mjs'
```

No new real Docker/native attachment proof was run. The existing attachment and
inspection API necessarily invokes native version/help; replaying that settled
generic matrix is not justified by this additive change. Actual composed-consumer
kernel proof remains outstanding; native MCP/Skill discovery, coordinated worker
consumer supervision, authenticated credentials, model dispatch and live acceptance
remain unsupported.

#### Fixed candidate layout and proxy configuration

Default network-only replacement controllers use `10001:10001`; startup cwd is `/boundary`.
Intended native cwd is described separately, and is initialized in bounded
tmpfs. Runtime, inputs and settings are separate issued readonly bind mounts:

| Client | Runtime mount | Settings mount | Intended cwd | HOME | Intended native state |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | `/opt/client` | `/probe` | `/workspace` | `/home/node` | `/home/node/.claude` |
| `copilot` | `/opt/fixture` | `/candidate-settings` | `/workspace` | `/home/eval` | `/client-config/copilot` |
| `opencode` | `/opt/client` | `/candidate-settings` | `/work/project` | `/work/home` | `/work/data/opencode` |

Inputs are `/candidate-inputs`. Claude writable roots are `/workspace`,
`/home/node`, `/scratch`; Copilot adds `/client-config` with separate HOME;
OpenCode uses `/work` (256 MiB) and `/scratch`. Other writable roots are 16 MiB
each. Every tmpfs is noexec/nosuid/nodev, mode 700, owned by UID/GID 10001.
The opt-in native path uses the distinct measured layout/UID contract above.

`profileEnvironment` records actual fixed HOME/config/XDG/TMPDIR values.
`nativeAuthRootLocator.containerPath` is an **intended configuration path only**:
Claude `/home/node/.claude`, Copilot `/client-config/copilot`, OpenCode
**`/work/data` (`XDG_DATA_HOME`)**, not its `/work/data/opencode` child.
It is never a custody path, authenticated profile, refresh permission, or mount
lease. All state starts empty in candidate-owned tmpfs. Auth custody must remain
independently bound/reviewed and cannot be upgraded by this handle.

Actual proxy URL is `http://<owned internal IPv4>:8080`, with no userinfo, path,
query or TLS replacement. `proxyEnvironment` sets all of:

```text
HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy = proxyURL
NO_PROXY no_proxy = empty
```

This is nonsecret routing configuration, **not evidence that any native client
supports/honors it**. No provider/API/base-URL/token environment is supplied.
`dockerConfigDirectory` describes only this boundary's empty sanitized host Docker
configuration for a trusted broker; never mount it into a guest or replace it
with a personal Docker config.

### Exact inspection fields

`describeEgressBoundary` returns:

```text
version owner status policyHash classification enforcementScope fixtureOnly
evidenceValidity networkIsolationVerified publicServiceEgressVerified
credentialIsolationVerified authenticationVerified toolIsolationVerified
authorizationVerified liveAccepted nativeRuntimeVerified nativeLimitsVerified
providerQuotaVerified billingVerified proxyURL expiresAt client observed
optional fixtureProof cleanup cleanupFailureCode
```

`client` contains `networkId`, `probeContainerId` (current owned controller ID),
`candidateId` (UUID or null), `dns`, `resolverHash`,
`dockerNetworkAndDNSArguments`, `verifiedSubject`, `otherContainerAdmission`.
`observed` contains timestamp, actual engine version/OS/architecture, Node
version, pinned image/actual image ID, exact networks/containers, candidate
routes/resolver/IPv6 facts, bounded relay classifications/counters/approved host
identities, and measured negative probe results. Container facts include actual
resource/privilege controls, readonly mount targets and exact typed tmpfs options.

`describeEgressCandidate` returns:

```text
version id boundaryOwner client expectedClientVersion status boundaryStatus
classification fixtureOnly evidenceValidity networkAttachmentVerified
nativeRuntimeVerified nativeLimitsVerified providerQuotaVerified billingVerified
publicServiceEgressVerified credentialIsolationVerified authenticationVerified
toolIsolationVerified authorizationVerified liveAccepted
containerId networkId image nodeVersion proxyURL expiresAt
staging {writable,runtime,inputs,settings}
mounts {runtime,inputs,settings}
workdir initialWorkdir home nativeStateRoot nativeAuthRootLocator nativeStateAuthority
user writableRoots dockerConfigDirectory profileEnvironment proxyEnvironment
seed {fileCount,bytes,aggregateHash} | null
observed | null
optional cleanup
```

Before attachment `containerId`, `seed`, `observed` are null and
`networkAttachmentVerified` is false. After successful attachment it is true only
while the boundary/candidate are active, based on the timestamped measurements,
not continuous or native attestation. `expectedClientVersion` is the intended
existing pin; **it is not an observed executable version**.
`observed` holds `measuredAt`, `policyHash`, `nodeVersion`, exact `container`,
`networks`, `runtime` route/DNS/IPv6 facts, `negativeProbes`, and, after fresh
inspection, `negativeProbesMeasuredAt`.

Cleanup fields are `owner`, `classification`, `containerIds`, `networkIds`,
`exactContainersAbsent`, `exactNetworksAbsent`, `directoryRemoved`,
`candidateSeedsRemoved`, `helperProcessesClosed`, `cleanupVerified`.
Descriptions remain available after successful stop, with inactive status and
the verified receipt; copied historical descriptions are never handles.

## Enforcement

* Exact lower-case ASCII DNS identities only, at most 32. Wildcards, URLs,
  userinfo, IP literals/aliases, trailing dots, Unicode/punycode, reserved local
  suffixes, duplicate identities, and ambiguous labels are rejected. There is no
  inferred provider-domain catalog or wildcard provider exception.
* Only complete bounded HTTP/1.1 `CONNECT name:443` framing is supported. Exactly
  one matching Host header is required. Supported optional headers are
  Keep-Alive Connection/Proxy-Connection and bounded User-Agent. Body framing,
  credential headers, unexpected headers/methods/ports, duplicates, and
  pipelining fail closed. Headers are neither forwarded nor logged.
* The initial TLS flight must be exactly one complete ClientHello, carried in
  at most eight handshake records and 32 KiB total. Record payloads are bounded
  to 16 KiB. TCP and record fragmentation are supported; excess, truncated,
  malformed, additional, or pipelined initial bytes are rejected. TLS 1.2/1.3
  legacy ClientHello framing is supported. Exactly one canonical plaintext SNI
  must match CONNECT. Missing SNI, ECH and ESNI are explicitly rejected.
* Public resolution checks every A/AAAA answer against global-address rules,
  rejecting loopback, private, link-local, shared, multicast, documentation,
  special-use/translation ranges, scoped/mapped addresses, and metadata
  destinations. Incomplete resolution fails. Complete answer sets must match
  before dialing and again after connecting. The relay dials a numeric address
  without a second implicit lookup and verifies the actual connected peer.
* No upstream connection is opened before the entire initial ClientHello
  passes. Afterwards bytes are streamed unchanged with backpressure. This is
  routing/initial-handshake inspection, **not TLS termination, application
  inspection, encrypted-name verification, or protection against sending data
  to an approved service**.
* Relay: 16 simultaneous requests, 3-second initial handshake/DNS budget,
  2-second connect budget, 5-second idle timeout and 15-second tunnel lifetime.
  Docker command/output and termination waits are also finite. Unsupported
  framing/extension behavior is not silently treated as verification.

## Owned Docker topology and lifetime

The exact existing `OFFLINE_NODE_IMAGE` digest, Node **22.22.1**, and Docker Engine
**29.7.2**, Linux/amd64, are checked against actual observations. Images must
already be local; `--pull never` is used and no image is built.

The probe has exactly one owned `--internal` bridge network. Its IPv4 gateway
mode is `isolated`, with masquerading disabled and no default route. Candidate
IPv6 is disabled. Only the relay shares that network; only the relay has a second
outbound attachment in the public topology. The local lab's fixture has solely
the outbound attachment.

Candidate DNS is explicitly loopback-only, with a read-only owned
`/etc/resolv.conf`; public forwarding is additionally disabled through Docker's
DNS setting. Actual resolver contents and routes are measured. Negative probes
include Docker's **explicit `127.0.0.11` embedded resolver**, not just ordinary
system lookup, external DNS and a controlled outside-network DNS fixture.

All containers use a read-only root, user `10001:10001`, cap-drop ALL,
no-new-privileges, 256 MiB memory/swap limits, one CPU, 64 PIDs, no host ports,
no restart policy, and logging driver `none`. The initial probe/relay only mount
separately whitelisted module snapshots and the owned resolver. The replacement
also mounts its own sealed SDK/input/settings areas, never into the relay or a
build context. No personal HOME, Docker socket, credential custody, or unrelated
host mount is supplied. Initial probe/relay HOME is `/nonexistent`; replacement
HOME/state are empty bounded tmpfs, **not prepared-home/authentication claims**.

Every resource carries a newly generated UUID ownership label plus exact role
and issuer. A separate nonce-bearing, hash-checked workspace marker and captured
Docker IDs support exact cleanup. Each Docker invocation uses its own sanitized
`--config` directory, empty auth configuration, fixed local engine address, and
minimal noncredential environment. No registry credentials or personal Docker
configuration are read.

Services use supervised, nondetached Docker attach processes and self-expire.
Abort/timeout triggers exact cleanup. Cleanup has an independent finite budget
and never uses a global resource list, wildcard removal, global network/firewall
mutation, or name-based process kill. Foreign/mismatched attachments are refused
before removal; only identity-verified owned services may be quiesced in that
failure path. If cleanup cannot be verified, an explicit error is returned and
the marked workspace is retained. A cleanup error can carry `recoveryHandle`,
the same genuine process-owned handle, for an explicit retry after correcting
the mismatch; serialization of it destroys that authority.

All public errors are `EgressBoundaryError`, with `classification: infrastructure`
and fixed codes/messages. Relevant families include `INVALID_*`, `OWNERSHIP_MISMATCH`,
`RUNTIME_DRIFT`, `CONFIG_MISMATCH`, `NETWORK_MISMATCH`, `CONNECT_*`, `TLS_*`,
`DNS_*`, `PEER_MISMATCH`, `TIMEOUT`, `CANCELLED`, and `CLEANUP_FAILED`.
Failure details, when present, are fixed control classifications and bounded
runtime facts—not raw requests, headers, wire bytes, credentials, or stderr.

## Local validation

Only the focused test file is needed; no native-client matrix or full suite:

```powershell
node --test --test-reporter=spec C:\Repositories\ai\evals\tests\live-boundary.test.mjs
```

Native attachment's focused **wiring-only** tests do not invoke Docker or
establish native proof:

```powershell
node --test --test-reporter=spec --test-name-pattern='wiring-only' C:\Repositories\ai\evals\tests\live-boundary-native.test.mjs
```

The separate opt-in native checks build case-independent public pinned images
through their existing owners, run one local attachment scenario per client,
and release the exact owned containers/images/networks/helpers. They make only
native version/help calls, not login/status/account/model/task calls:

```powershell
$env:EVAL_NATIVE_ATTACHMENT_DOCKER = '1'
node --test --test-reporter=spec --test-name-pattern='REAL native attachment' C:\Repositories\ai\evals\tests\live-boundary-native.test.mjs
```

`harness/live-boundary/native-attachment-evidence.json` retains sanitized
historical per-client observations and exact cleanup receipts. No runtime or
admission API reads it. Selecting one client updates only that client's history;
old observations are never reused as passing tests or active native authority.
This is separate from the already-settled relay fixture lab below; do not
replay that lab or the 18-session offline matrix to validate native attachment.

Opt in to the single deterministic real Docker fixture scenario:

```powershell
$env:EVAL_LIVE_BOUNDARY_DOCKER = '1'
node --test --test-reporter=spec --test-name-pattern='ONE opt-in' C:\Repositories\ai\evals\tests\live-boundary.test.mjs
```

The lab uses a distinct fixture-only entrypoint/issuer, exact owned fixture
address, and a newly generated local test certificate. Public host policy rejects
its `.test` identities; it provides no production private-address relaxation.
Real TLS echo traffic is compared with raw encrypted-stream hashes/byte counts
at both ends, without retaining raw payloads. The test asserts:

* Actual network/container/config/runtime facts, zero candidate default routes.
* Raw outside TCP, metadata, external/embedded/configured DNS, and outside fixture
  DNS denial; the same outside fixture is reachable only through the allowed relay.
* Bad host/SNI, private/wrong DNS answer, unknown DNS, IP authority, HTTP, port,
  missing SNI/ECH, plaintext, pipelining, truncation and oversize denial, with
  corresponding measured relay classifications.
* Certificate-verified encrypted TLS passthrough, byte-for-byte.
* Original-handle candidate issuance/binding/clone rejection, replacement of the
  retired probe by a measured network-only slot, and a fresh trusted inspection.
  This slot contains a public placeholder, **not a native executable**.
* Four exact owned container identities (including the retired probe), two
  networks, four attached helpers, and both UUID workspaces cleaned up.

The fixture rebinding probe changes to an address outside its single issued
destination and is rejected as `DNS_NONPUBLIC`. Public-to-public answer-set
rebinding and peer-address mismatch are covered by focused units, not by a
claim that public service traffic was exercised.

`harness/live-boundary/lab-evidence.json` is bounded sanitized historical lab
evidence. No admission API reads or trusts that file. Initial lab attempts exposed
Docker start/exec timing and unstarted-container cleanup differences; those were
fixed, regression-tested, and their exact resources were removed.

### Remaining unverified boundary

No provider/authentication/login/status/model/account request has been made.
Public native-service success, endpoint completeness, proxy/ClientHello
compatibility of Claude Code 2.1.291, Copilot CLI 1.0.92 and OpenCode 1.14.28,
authenticated native-client confinement, normal supported isolated login, credential
scope, tool controls, and authorization are **unverified**. A fixture success
cannot prove them. Neither the new module nor a caller-supplied policy,
prepared HOME, image tag, copied receipt, or boolean can unblock live execution.

The production `egress-only` start proves the owned negative network/DNS probes,
runtime pins and measured topology/configuration controls. Its public routing
policy/parser/address protections are enforced but **successful public-service
TLS connectivity is not measured**: no provider request is made. The local lab's
successful encrypted fixture echo is not public/native/account acceptance.

Native proxy compatibility beyond version/help, supported isolated
login/status/refresh, root-versus-tools credential scope, model authorization,
provider account quota, native total token/turn limits and billing controls remain
separate blockers. Docker CPU/memory/PID/deadline limits are real resource controls,
not provider quota, paid-budget limits or native accounting. No login/status,
provider/model/account, quota or billing query is part of this implementation.
It returns neither an authenticated candidate attachment nor a live lease.

## Original native-image manifest observation

`harness/live-boundary/native-image-manifest.mjs` adds a **credential-free,
local image-artifact observation**, independent of candidate attachment, profiles,
the scheduler, authentication, or native task execution. Import it directly;
the existing boundary exports and behavior are unchanged.

```js
import {
  observeNativeImageManifest,
  describeNativeImageManifestObservation,
  assertNativeImageManifestObservation,
  releaseNativeImageManifestObservation,
  NativeImageManifestError,
  NATIVE_IMAGE_MANIFEST_LIMITS
} from '../harness/live-boundary/native-image-manifest.mjs';

// ORIGINAL active handle from this client's existing case-free image constructor.
// No Docker tag, ID, description/clone, auth root, endpoint, or proof callback.
const observation = await observeNativeImageManifest({
  client: 'claude-code',
  imageHandle,
  timeoutMs: 120000,
  signal: optionalAbortSignal
});
try {
  const historical = describeNativeImageManifestObservation(observation);
  const binding = await assertNativeImageManifestObservation(observation, {
    client: 'claude-code',
    imageHandle // Exactly the original object, not a matching string or DTO.
  });
} finally {
  await releaseNativeImageManifestObservation(observation);
  // Separately release imageHandle using its ORIGINAL client image cleanup API.
}
```

### API, original binding, and lifetime

* `await observeNativeImageManifest({client, imageHandle, timeoutMs?, signal?,
  maxOutputBytes?, maxArchiveBytes?, maxUncompressedLayerBytes?})` returns a
  frozen null-prototype `{id, kind:
  'process-owned-native-image-manifest-observation'}`. Exact own data properties
  only; getters, proxies, unknown/symbol keys, additional arguments, process
  overrides and caller archive/configuration paths are rejected. The original
  issuers are Claude `prepareNativeImage`, Copilot `buildNativeImage`, and OpenCode
  `prepareNativeRuntimeImage`, with the existing pinned versions
  2.1.291/1.0.92/1.14.28. Issuer-private describe/assert APIs resolve authority
  through `native-image.mjs`. A public description, matching image/config digest,
  image tag, clone, or genuine cross-client image handle cannot establish it.
* The observation's module-private WeakMap retains the **exact original image
  handle**, owner UUID, client, and immutable image ID. Image labels and metadata
  are freshly inspected before and after export, and the original issuer is
  checked again. Fresh native descriptor/backend facts establish whether that
  Docker ID names a **config** or an **image manifest**, never digest equality
  alone. Config-typed IDs require exact config-blob equality; manifest-typed IDs
  require the exact raw exported target's digest, media type and size to match
  the fresh descriptor. Actual config bytes, descriptor sizes, decoded config
  facts, blob SHA-256 bytes, actual tar/gzip-tar media identity and
  every ordered uncompressed layer DiffID must agree with both config and fresh
  Docker `RootFS.Layers`. This does not run or observe a native executable.
  It preserves existing distinct client image user/layout contracts: Copilot
  10001:10001 and Claude/OpenCode 1000:1000; it introduces no common runtime UID.
* `describeNativeImageManifestObservation(originalObservation)` synchronously
  returns a deeply frozen, timestamped historical description. It never
  refreshes Docker or checks continued image activity. It remains readable after
  image cleanup or observation release; serialized descriptions are not authority.
* `await assertNativeImageManifestObservation(originalObservation,
  {client, imageHandle: originalImageHandle})` additionally requires an unreleased
  original observation, exact object/client binding, and still-active original
  issuer ownership. It resolves to the same description shape as `describe`,
  **not `undefined`**, after recapturing the original issuer's private authority
  and checking the retained original owner/image ID. It is **not fresh Docker
  inspection, manifest export or ongoing attestation**.
  Different genuine image handles cannot rebind it. Original issuer release
  invalidates assertion even though the historical description remains readable.
* `await releaseNativeImageManifestObservation(originalObservation)` is
  idempotent, revokes the retained original-image binding, and returns the
  observation ID plus its already-verified export cleanup receipt. No export
  workspace survives successful observation. Release never deletes or releases
  the borrowed client image, and assertion after release fails explicitly.

For an async native-candidate inspection, call `assertNativeImageManifestObservation`
**after that inspection's await**. Match the returned `client` and original
`imageId` (also `originalImageAuthority.imageId`) to the actually inspected
candidate; `originalImageAuthority.owner` remains the original issuer owner.
The assertion rechecks issuer activity at that moment, including release during
its own await. `describe` alone, `originalImageHandleRetained: true`, a timestamp,
or copied digest fields do not check issuer activity. The observation must
remain unreleased and its original image handle must still be active. Neither
method starts a native task or grants authentication, limits, execution, or a
registry/signer verification.

Descriptions contain these exact fields:

```text
observationId client clientVersion observedAt status originalImageHandleRetained
classification provenance registryManifestVerified authenticationVerified liveAccepted
originalImageAuthority {issuer,owner,client,clientVersion,imageId,imageIdType}
imageId imageIdType dockerImageId dockerImageIdType dockerImageIdProvenance
dockerDescriptor {mediaType,digest,size}|null legacyGraphDriver dockerRootFSDiffIds
imageIdentityVerified manifestTargetVerified
configDigest configDigestType configMediaType configSizeBytes sourceConfigMediaType configFactsVerified
layerBlobDigestsVerified layerMediaVerified layerDiffIdsVerified
manifestDigest manifestDigestType manifestMediaType manifestSizeBytes manifestJSON manifest
sourceManifestDigest sourceManifestMediaType sourceLayerMediaTypes
layers [{...manifest.layers[i],diffId}]
archive {format,bytes,digest} uncompressedLayerBytes imageInspection bounds cleanup
```

`imageInspection` is the existing native metadata validator's frozen result:
`{inspectedAt,id,owner,ownerLabel,os,architecture,imageUser,imageWorkdir,
imageEntrypoint,environment}`. `bounds` contains exactly
`{timeoutMs,maxOutputBytes,maxArchiveBytes,maxUncompressedLayerBytes,
maxArchiveEntries,maxLayers,maxJSONBytes,maxZstdWindowBytes}`.
`maxZstdWindowBytes` is fixed at `134217728`.
`sourceLayerMediaTypes` retains every actual exported layer descriptor media
type in order, including Docker gzip descriptors inside a native OCI manifest.
`status` is `'observed'` or
`'released'`; it is not an assertion of continued native-image activity.

`imageId` and `dockerImageId` preserve the ORIGINAL issuer's immutable Docker ID,
with matching `imageIdType`/`dockerImageIdType` equal to either
`'docker-image-config-id'` or `'docker-image-manifest-id'`. Fresh
`dockerDescriptor` is the native target `{mediaType,digest,size}` or `null` for
the explicit classic-backend path; `legacyGraphDriver` is the recognized classic
driver or `null`. `dockerImageIdProvenance` is exactly
`'fresh-docker-image-inspect-descriptor'` or
`'fresh-docker-image-inspect-legacy-graphdriver'`.
`configDigest` always hashes the actual exported config blob; it is **not**
necessarily the Docker image ID. Its local OCI type is
`configDigestType: 'oci-image-config-digest'`,
`configMediaType: 'application/vnd.oci.image.config.v1+json'`; the source's
declared media type is separately retained as `sourceConfigMediaType`.
`manifestDigest` is separately hashed from **exact `manifestJSON` UTF-8 bytes**,
with `manifestDigestType: 'local-oci-image-manifest-digest'` and
`manifestMediaType: 'application/vnd.oci.image.manifest.v1+json'`. `manifest` is its
parsed frozen object. `layers[].digest` hashes the actual stored blob;
`layers[].diffId` hashes its actual uncompressed tar stream. Compressed layer
blob digests are not interchangeable with DiffIDs.
Layer descriptors preserve their original OCI fields, including
`{mediaType,digest,size}`, plus the verified `diffId`; Docker-v2 conversion retains
actual stored hashes/sizes while mapping only supported media types into the
derived OCI manifest. `dockerRootFSDiffIds` contains the fresh original ordered
Docker DiffIDs. `imageIdentityVerified`, `configFactsVerified`,
`layerBlobDigestsVerified`, `layerMediaVerified` and `layerDiffIdsVerified` record
historical local checks. `manifestTargetVerified` is true only for a freshly
descriptor-verified original manifest target (including the **source**, not
converted OCI, Docker-v2 target). None of these booleans grants native admission.

Native OCI manifests preserve their **exact original bytes and descriptor media
types**, including the OCI-spec-compatible
`application/vnd.docker.image.rootfs.diff.tar.gzip`. Media selection is separate
from root-manifest identity: a Docker layer descriptor inside an OCI manifest
does not cause its raw manifest to be rewritten or hashed as another identity.
The [OCI media compatibility matrix](https://github.com/opencontainers/image-spec/blob/main/media-types.md)
explicitly identifies Docker gzip and OCI gzip layers as interchangeable.

### Local OCI provenance, not registry proof

The only export process is the native owning **Docker `image save <immutable-ID>`**.
Its stdout is spooled without archive extraction. When Docker emits a supported
OCI layout, the original OCI manifest blob is verified and preserved verbatim;
no helper image, conversion container, registry lookup or additional dependency
is used. Supported provenance is exactly:

| Archive/content | `provenance` | `sourceManifestDigest` |
| --- | --- | --- |
| OCI layout with OCI manifest | `local-oci-layout-exported-by-docker-image-save` | Actual exported OCI manifest blob digest |
| OCI layout with Docker schema-2 manifest, converted locally to OCI | `local-oci-manifest-derived-from-docker-save-docker-v2-manifest` | Actual Docker schema-2 source blob digest, **not** the derived OCI digest |
| Legacy Docker save config and uncompressed layer tars, reconstructed locally to OCI | `local-oci-manifest-derived-from-docker-save-layer-tars` | `null` |

All three are `classification:
'local-image-manifest-observation/not-registry-proof'` and
**`registryManifestVerified: false`**, `authenticationVerified: false`,
`liveAccepted: false`. An existing repo-digest string or Docker descriptor field
is not consulted as registry proof. Deriving an OCI manifest from config/layer
bytes cannot reconstruct or certify an existing registry's manifest encoding,
compression, signatures, or digest. A caller's per-client local-OCI pin must
compare **both** `manifestDigest` and `configDigest` with the original bound
observation; generic profile image text cannot approve unrelated child images.
The optional captured per-client pin shape is
`{kind:'local-oci',manifestDigest:'sha256:<64hex>',configDigest:'sha256:<64hex>'}`;
its strings cannot replace the original observation or active original-image
binding. Shared `profile.image` alone remains unverified. This module neither
consumes pins nor issues profile/admission authority.

### Bounds, supervision, and exact cleanup

Defaults (`NATIVE_IMAGE_MANIFEST_LIMITS`) are: 120-second shared observation
deadline, 128 KiB per inspection stdout+stderr or export stderr, 1 GiB archive
bytes, 2 GiB aggregate actual uncompressed layer bytes, 512 archive entries,
128 layers and 1 MiB per JSON blob. Public ranges are timeout 1,000–300,000 ms,
output 1–262,144 bytes, archive 1,024–2,147,483,648 bytes, and aggregate
uncompressed layers 1,024–4,294,967,296 bytes. The aggregate layer bound also
limits gzip expansion. No tar entry is ever extracted into the filesystem.

OCI `application/vnd.oci.image.layer.v1.tar+zstd` uses Node's native streaming
decoder when available, with a **fixed 128 MiB maximum decoder window**, 64 KiB
stream chunks, the same aggregate uncompressed-byte cap and shared deadline.
An independent incremental [RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.html)
frame validator checks the standard magic/header, reserved bits, dictionary
absence, window declaration, bounded block framing, complete required checksum
bytes, final block and declared content size. This is necessary because native
Node decoding can accept truncated checksum bytes or ignore an additional frame.
Native checksum/decompression checks, complete inner tar framing and exact
fresh RootFS DiffID verification remain required. Only one complete standard
Zstandard frame is supported; concatenated/skippable frames, external
dictionaries, excessive windows and unavailable bounded native decoders deny.
Both raw stored blob hash/size and uncompressed DiffID are independently checked
while streaming. Zstandard support is unit-tested; the actual proof below used
gzip layers, not Zstandard.

Only a newly UUID-owned `live-boundary\.owned\manifest-<UUID>` workspace is
created, with an exclusive archive file, nonce/hash-protected marker, and empty
owned Docker configuration/HOME/appdata/scratch directories. Stream chunks are
checked **before writing** beyond the archive cap; fixed control files add less
than 4 KiB. Environment is minimal, uses the installed local Docker executable
and fixed local engine address, and points HOME/USERPROFILE/appdata/temp solely
at these empty owned paths. It does not inherit personal credentials, proxy,
provider, Node option, Docker context or registry-auth configuration.

Cancellation and expiry terminate the exact nondetached helper, wait for its
close event (maximum additional 1.5 seconds), close layer/file streams, then
validate and remove only recorded exact files/empty directories. There are no
containers, network changes, Docker image deletions, prune commands, or `.owned`
or `.work` sweeps. Cleanup receipts contain:

```text
exportId archiveRemoved dockerConfigRemoved workspaceRemoved
helperProcessesClosed containersCreated:0 nativeImageRemoved:false cleanupVerified:true
```

Failures are explicit `NativeImageManifestError` with fixed code/message and
`classification: 'infrastructure'`. Successful failure-path cleanup is attached
as `cleanup` and `cleanupVerified: true`. Unverified helper termination or
filesystem identity/inventory/marker drift never publishes an observation:
`cleanupVerified: false`, `cleanupErrorCode` and the exact `retainedDirectory`
identify the conflict. It is not silently deleted or upgraded to passing proof.
After raw target/config and blob verification, failure can additionally carry
deeply frozen `rejectedArtifact` diagnostics: actual original `imageId`,
`imageIdType`, `dockerDescriptor`, actual `manifestDigest`/`sourceManifestDigest`,
`configDigest`, `sourceConfigMediaType`, archive facts and ordered layer
`{mediaType,digest,size,declaredDiffId}` descriptors. Unsupported/failed layers
retain `layerIndex` and `layerMediaType` from the exported descriptor.
`rejectedArtifact.originalObservationIssued: false`, registry/auth/live flags
remain false and layer media/DiffID verification remains false. A rejected DTO
is not a WeakMap-registered observation or usable admission capability. If a
Docker-v2 source cannot be converted, its local `manifestDigest` remains `null`;
the exact raw `sourceManifestDigest` is retained rather than fabricated.
This is local process-owned capability integrity, not protection against a
malicious same-host administrator or a compromised Docker daemon.

**Docker ID semantics are checked, not assumed.** The containerd backend can
return an OCI manifest/index target digest as Docker inspect `Id`, rather than
the config SHA-256 described by the legacy API comment (see the owning
[Moby containerd inspection implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go)).
Fresh supported native `Descriptor.mediaType` establishes manifest/config
typing and must bind its digest to the original `.Id`. The exported exact raw
target bytes must then match its digest, media type and size. A Docker-v2 target
is matched against the actual Docker-v2 source, never against locally rewritten
OCI bytes. Index-typed original targets deliberately fail with
`IMAGE_ID_TYPE_UNSUPPORTED`; this slice does not choose a child to replace
original image authority. Missing descriptors qualify only through an explicitly
recognized classic `GraphDriver.Name` (`overlay2`, `aufs`, `btrfs`, `zfs`, `vfs`,
`devicemapper`, `fuse-overlayfs`) plus exact actual config digest equality.
A missing descriptor alone, a snapshotter name such as `overlayfs`, unknown
media, conflicting digest, omitted size, external/embedded target or unsupported
index type never qualifies merely because two strings happen to match.
`IMAGE_ID_TYPE_UNVERIFIED`/`IMAGE_ID_TYPE_UNSUPPORTED` include the fixed
`imageIdentityField` naming the unverified native field;
`IMAGE_TARGET_MISMATCH` identifies an exported target/descriptor conflict.

The config's actual blob digest, descriptor size and media type are checked
regardless of Docker ID type. Decoded OS/architecture/variant, user, workdir,
entrypoint, command, environment, labels, volumes, ports, on-build, healthcheck,
stop signal, shell and args-escaped facts must agree with fresh original
inspection; omitted/null empty optional forms and map-key order are normalized,
not arbitrary values. Ordered `config.rootfs.diff_ids` must match fresh Docker
`RootFS.Layers`, then each actual uncompressed layer must hash to that DiffID.
All stored/compressed layer digests/sizes, gzip integrity and tar framing/media
checks remain bounded. Final fresh inspection rechecks identity type/descriptor,
config facts, RootFS and original issuer before verified cleanup and publication.
This corrects a type/provenance integration bug; it never equates config with
manifest identity or upgrades a local export to registry/signer proof.

Supported shapes are complete uncompressed outer ustar archives containing a
single unambiguous Linux/amd64 OCI image (single-descriptor index chains, depth
at most four) or one legacy Docker save image. Only OCI tar/gzip-tar/single-frame Zstandard-tar and their
Docker schema-2 tar/gzip counterparts are supported. Ambiguous multi-image or
attestation indexes, external/embedded descriptors, unknown archive entries,
outer link/PAX/GNU-extension entries, unsupported/foreign layer types, incomplete
archives and malformed tar/gzip bytes fail explicitly rather than succeeding
with invented identity.

### Focused validation and actual observation

Default tests replace only Docker process orchestration with explicitly labeled
doubles, using the actual original image-issuer handle contracts. They are
wiring/byte-validation tests, **not fake native execution or admission**:

```powershell
node --test --test-reporter=spec C:\Repositories\ai\evals\tests\native-image-manifest.test.mjs
```

The one opt-in actual scenario constructs a new original case-free Claude image,
exports/validates its config, manifest and layers without executing a native
client, and releases observation plus original image in `finally`:

```powershell
$env:EVAL_NATIVE_IMAGE_MANIFEST_DOCKER = '1'
node --test --test-reporter=spec --test-name-pattern='^REAL credential-free' C:\Repositories\ai\evals\tests\native-image-manifest.test.mjs
```

It prints compact `NATIVE_IMAGE_MANIFEST_ACTUAL_EVIDENCE` only after exact export
and original-image cleanup. A passing current actual test **requires a genuinely
issued original observation**, complete config/layer validation, observation
release and exact image/export cleanup. A denied export prints an explicit
`NATIVE_IMAGE_MANIFEST_ACTUAL_FAILURE`, then fails the test; there is no
success-shaped denial branch.
It never replays the settled three-client
version/help probes, relay lab, or 18-session offline matrix, and makes no
login/status/account/provider/model/AI-judge call. Registry provenance,
authenticated live admission and all original live blockers remain unverified.

#### Historical config-only-contract denial — 2026-10-09

The initial credential-free original Claude image export at
`2026-10-09T13:34:33.617Z` was **rejected** with `CONFIG_DIGEST_MISMATCH`;
**no original manifest observation was issued**. Original image owner was
`3a3936fd-4b13-443e-a5a3-1170b888a782`, from Claude's case-free
`prepareNativeImage` (2.1.291, pinned Node 22.22.1). Docker directly emitted an
OCI layout with 9 layer blobs and a 2,275-byte OCI image manifest.

```text
outcome: rejected/unsupported-docker-config-id-semantics
classification: rejected-local-image-manifest/config-id-mismatch
provenance: local-oci-layout-exported-by-docker-image-save
imageIdType: docker-oci-manifest-target-id
imageId / actual manifestDigest:
  sha256:4d0b6159d4bedbe27b1ec47a1d65c5e91b1e7d5f1aaa2e9973f5da7013f0d6f1
actual configDigest:
  sha256:4d3c2c87d6f80e4981790e862020b9fde1fe7964c3639c85c01e6b3145e7d7f3
archive: 524109312 bytes
archiveDigest:
  sha256:326e867b961d046a0cb9768b57913d8f2ebc9110887ceedc3733309791eefd40
configMatchesDockerImageId: false
originalObservationIssued: false
manifestBlobVerified: true
layerBlobDigestsVerified: true
layerMediaVerified: false
registryManifestVerified: false
authenticationVerified: false
liveAccepted: false
```

The native fresh Docker descriptor identified that same original `imageId` as
`application/vnd.oci.image.manifest.v1+json`, not config identity. The two
different config/manifest hashes were **not equated or promoted to passing
authority**. Uncompressed layer/media validation was not reached after this
strict denial; no claim of its actual verification is made.

Export `dcdb0f14-1b74-459d-ac32-0aee79be1215` verified archive, empty Docker
configuration, workspace and helper-process cleanup; zero containers were
created. Original Claude cleanup then verified its exact image and host
configuration removal. The selected actual feasibility test passed by asserting
this explicit unsupported-host outcome and both cleanup receipts, **not** by
accepting a local-OCI pin or authenticated/live execution.

#### New typed-contract actual feasibility failure — 2026-10-09

One new original case-free Claude image/export was attempted after the explicit
Docker target/config typing correction. The selected actual test **failed** with
`NativeImageManifestError`, `classification: 'infrastructure'`,
`code: 'LAYER_MEDIA_UNSUPPORTED'`. Original image owner was
`42195cba-c625-447f-a5d2-93c4d517c1c1`; exact export ID was
`6f1e1999-8dc9-4fdf-b05d-a0759559ee3f`. The actual failure was reached after
raw source-target/config descriptor and decoded config/RootFS checks, but before
uncompressed layer media/DiffID verification and final fresh inspection.
**No original observation was issued.** The failure log did not retain the
rejected config/manifest hashes or individual unsupported media value; those
values are unavailable, not reconstructed or taken from the earlier image.
This is a remaining archive-media feasibility limitation, not a descriptor
typing denial, successful local-OCI pin, or authenticated/live acceptance.

The failure's exact cleanup receipt verified archive, empty Docker
configuration, workspace and helper-process removal, with zero containers
created. Original Claude cleanup verified its exact image and host configuration
removal. The one authorized export was not replayed. The selected real test
remains a failing test on this export shape; it does not convert the denial into
success. Default targeted validation passed **38 units**, with the one actual
opt-in skipped; **12 selected typed-ID units** passed independently.

#### Corrected actual original-image observation — 2026-10-09

After a unit-reproduced media-selector fix and bounded codec/framing tests,
**one** new case-free original Claude image was constructed. At
`2026-10-09T14:51:40.578Z`, it genuinely issued observation
`12578119-ed7d-47c0-af82-c7fbfd17aebd`, bound to original image owner
`ee20f825-ce97-4640-b5f8-9963feeabb49`. Claude is pinned to 2.1.291 and image
Node to 22.22.1. No native executable/session, authentication or provider call
was made.

The newly retained actual media evidence is precise:
**layers 7 and 9** (one-based) declare
`application/vnd.docker.image.rootfs.diff.tar.gzip`; the other seven declare
`application/vnd.oci.image.layer.v1.tar+gzip`. The native root manifest declares
`application/vnd.oci.image.manifest.v1+json`. The old selector erroneously
rejected Docker layer media inside an OCI root manifest, although the OCI
compatibility matrix identifies it as the same gzip layer format. The corrected
selector preserves the original media and raw manifest bytes, applies the
bounded gzip decoder, and independently verifies stored hashes/sizes, complete
tar output and every fresh original RootFS DiffID.
This actual proof establishes the media mix for **this new original image**;
it does not reconstruct the unrecorded hashes/media of the previously cleaned
failed image. No Zstandard layer occurred in the actual proof.

```text
outcome: observed/local-artifact-only
classification: local-image-manifest-observation/not-registry-proof
provenance: local-oci-layout-exported-by-docker-image-save
imageIdType: docker-image-manifest-id
imageId / manifestDigest / sourceManifestDigest:
  sha256:ee1a2ba59bd26cbace2b4572d18d88a87271cd173a9c5a1f9bf01d68dba741c9
configDigest:
  sha256:b8377744e0536eddf72dac158a704971640301479475d3feef2fc93191e20004
dockerDescriptor: application/vnd.oci.image.manifest.v1+json, 2275 bytes
configMediaType: application/vnd.oci.image.config.v1+json, 8481 bytes
archive: oci-layout, 524108800 bytes
archiveDigest:
  sha256:99081a32d06cb28654ad61778387dc247584f86c0b67aff50892c442dcda088c
layers: 9
uncompressedLayerBytes: 949803008
originalObservationIssued: true
configFactsVerified: true
layerBlobDigestsVerified: true
layerMediaVerified: true
layerDiffIdsVerified: true
registryManifestVerified: false
authenticationVerified: false
liveAccepted: false
```

Actual layer evidence (`digest` hashes stored compressed bytes, `diffId` hashes
the actual uncompressed tar; all hashes are SHA-256):

| Layer | Actual media | Stored bytes | Stored digest | Uncompressed DiffID |
| --- | --- | ---: | --- | --- |
| 1 | OCI gzip | 28236225 | `6db0909c4473287ed4d1f950d26b8bc5b7b4206d365a0e7740cb89e46979153e` | `6143ee9e3de07e6ca35edaf392cf93dea566a5bcd0d3696607ae6c324193d099` |
| 2 | OCI gzip | 3310 | `e260c4bd6721aa9cf70355d170f8cad17e2194840a22c0bc9afae1789fb6a731` | `d91a4ca5dda075b78127df40f1f74a39e87c08f4aea9c5f7dd3cf854a35f0d5c` |
| 3 | OCI gzip | 49949707 | `1cb89e70384b59a4860d1f1c56f6f91043d2f8e1394bd9799d7d576f1199fd40` | `baa30d2615a75bfbcaeb56c965fac1e46b6456e3fe290a7d96d0f9641c8854b1` |
| 4 | OCI gzip | 1712674 | `5b65622f4612343e8373dca1cc9358d43b393ded920a92da897b8a82b5d51139` | `17db811a82c8f26101b5027fc3a8d772d07b5fdda631a7465df53efdec02070b` |
| 5 | OCI gzip | 447 | `1f07293921e5871b5544e13097dc0c65d28920dc8a5f94216e2af10843f7986e` | `91ea465689b5454d335c02f6ab6e81f7e9674d2f859d73cf54c8e3fe40603fb6` |
| 6 | OCI gzip | 115 | `2e32664ed2358a30e15bc3e3ba7c88150e9dfeb3aa7cb3dacb7423dd9b2d2af5` | `5099d5fd516ab5a02823d9b3e70b29bdcccce606c6a697fceb3fc1dd87bbc9c7` |
| 7 | Docker gzip | 1443 | `8e6a30b422c15577c29de3f0788a46b5ebd86eaf8304ed4b1bc1200fbad5f268` | `6ba6852fc8908327e96c29b84fd99168a359cad3c971fea1716b55f691081574` |
| 8 | OCI gzip | 444169151 | `3beb33fc265579d38ec56d7dccd274eec5de83e3f83b9c85de0e68cadd901693` | `adb386fb3e12a73fb11c1ef3bf8714b86152608a50f77b008224d01a3fdf7ccf` |
| 9 | Docker gzip | 10949 | `b4fb6b01c8cac8fe022c35d61e4713cee76837e2fa8a02299f40d8d2465f7e0a` | `8527fd47353b627706ee5c66dd7e9031717f81ccc5a83a0a954a8f2497f6d8e2` |

Final fresh descriptor/config/RootFS and original issuer checks passed.
Publication happened only after exact archive, empty Docker configuration,
workspace and helper-process cleanup verified, with zero containers created
and no borrowed native image removal by the observer. Observation release then
revoked its binding; assertion after release was explicitly denied. Original
Claude cleanup verified its exact image and host configuration removal.
Both exact owned workspace paths were separately confirmed absent.
The selected actual test passed **1/1**, not a unit proxy or success-shaped
denial. Latest default validation passed **45 units**, with one actual opt-in
skipped; **7 focused media-codec units** passed. Original/authenticated live
admission and registry/signer verification remain unverified.
