# Isolated filesystem tool worker

This foundation is **not accepted authenticated custody and cannot enable a live
evaluation**. It implements local filesystem tools, not a model proxy, provider
gateway, native client, native skill catalog, or grader. Every report keeps
`authenticationVerified`, `nativeDiscoveryVerified`, and `liveAccepted` false.

## Boundary

The broker starts fixed, snapshotted worker code using the existing public
`node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d`
pin and verifies Node **22.22.1** inside the actual worker. There is no selectable
image, executable, script, shell, plugin, configuration, URL, Docker endpoint,
PID, resource ID, host path, environment, authentication assertion, or native
proof input.

The worker has its own Docker container, PID/mount/network namespaces, UID/GID
10002, supplemental GID21000, dropped capabilities, no-new-privileges, readonly
root, bounded writable `/workspace` and `/scratch` tmpfs, no external network,
no host bind mounts, no HOME mount/import, no Docker socket, and no provider/auth
environment. `/usr/bin/env -i` clears image/host environment before executing
the fixed Node program. Docker control commands use a separate owned empty
Docker configuration directory and the existing sanitized control environment.

Only an owned 64 KiB tmpfs Docker volume at `/tool-rpc` is shared with peers.
It contains **one Unix socket**, not worker files, credentials, code, or evidence.
The volume root is 10002:21000 mode0710; the socket is 10002:21000 mode0660.
Peers mount this volume readonly and add supplemental GID21000. Their original
UID/GID1000:1000 or10001:10001 must be preserved, never unified with the worker.
Readonly socket mounts permit connection, not directory listing, replacement,
configuration import, or workspace access.

Docker's daemon-default **user namespace may be shared**. A distinct unprivileged
UID plus measured separate PID/mount namespaces is not proof of a private
kernel user namespace. If native acceptance requires private user namespaces,
the native control plane must supply and verify that additional primitive.

## Public broker API

The API **entry module** is
`C:\Repositories\ai\evals\harness\tool-worker\index.mjs`
(`evals/harness/tool-worker/index.mjs` as an ESM import). The exported signatures are:

```js
issueToolTask({ invocationId, caseId, client, arm, repeat }) // synchronous TaskHandle
prepareToolWorker({ task, publicFiles, artifactTargets, limits? }) // synchronous WorkerHandle
startToolWorker({ task, worker, signal? }) // Promise<WorkerDiagnostics>
requestToolWorker({ task, worker, request, signal? }) // Promise<WorkerResponse>
inspectToolWorker({ task, worker, signal? }) // Promise<WorkerDiagnostics>
captureToolWorkerArtifacts({ task, worker, signal? }) // Promise<ArtifactCapture>
leaseToolWorkerTransport({ task, worker, signal? }) // Promise<TransportLease>
resolveToolWorkerTransportLease({ task, worker, lease, signal? }) // Promise<TransportBinding>
assertToolWorkerTransportBinding({ task, worker, lease, binding, signal? }) // Promise<BindingDiagnostic>
describeToolWorkerTransportBinding({ task, worker, lease, binding }) // synchronous PlanningDescription
closeToolWorker({ task, worker }) // Promise<CleanupDiagnostic>
```

Other exports are `TOOL_PROTOCOL`, `TOOL_CAPS`, `TOOL_WORKER_IMAGE`,
`TOOL_WORKER_NODE_VERSION`, and `ToolWorkerError`.

- `client`: `claude-code`, `copilot`, or `opencode`; this labels task coordinates,
  **not an observed native client**.
- `arm`: `candidate`, `baseline`, or `no-skill`; `repeat`: 1, 2, or 3.
- Task identifiers are bounded portable identifiers. Exact fields are required;
  private fixture/check hashes or answer metadata are not task coordinates.
- `publicFiles`: explicit `{ path, content }` objects, where `content` is a
  copied string or Buffer and `path` begins `skills/` or `inputs/`.
- `artifactTargets`: exact strings beginning `artifacts/`. No expected answers,
  checks, target permissions, symlink/link types, executable bits, directory
  imports, mount roots, or source paths are accepted.
- `limits` can only lower the fixed caps:
  `files:32`, `targets:8`, `fileBytes:16384`, `sourceBytes:131072`,
  `artifactBytes:131072`, `requests:64`, `requestBytes:32768`,
  `totalRequestBytes:262144`, `outputBytes:524288`, `timeoutMs:60000`.
- At most four prepared/unclosed workers exist in one broker process.

Handles are immutable **original object identities** in broker WeakMaps:

| Original handle | Public fields |
| --- | --- |
| Task | `kind:"tool-worker-task"`, immutable `coordinates` |
| Worker | `kind:"tool-worker"`, `protocol` |
| Transport lease | `kind:"tool-worker-transport-lease"`, `protocol` |

Copies, structured clones, serialized/reconstructed objects, same-coordinate
other tasks, caller IDs, tags, PIDs, paths, and booleans are not authority.
A task issues one worker. A running worker issues one lease. Cleanup invalidates
all runtime/lease/binding authority; exact original cleanup itself is idempotent.
Task issuance validates and binds public coordinates but does **not** attest
that a native task/authentication handle was issued elsewhere.

There are no `{handle,report}` wrappers. Prepare returns the original worker,
start returns descriptive diagnostics, lease returns the original lease, resolve
returns the original binding (the same reference on repeat), and assert returns
descriptive diagnostics. Prepare validates metadata before nonce allocation.
All post-allocation preparation steps are transactional: successful rollback
proves removal and throws `OWNED_PREPARATION_FAILED` with `cleanup`, leaving the
task eligible for retry. If rollback itself fails, `PREPARATION_CLEANUP_FAILED`
carries the **issued original opaque `error.worker`** and sanitized cause codes;
its slot/task issuance remain reserved until exact original-handle cleanup.
No partially prepared resource is stranded without recovery authority.

The original frozen transport binding contains:

```js
{
  kind, protocol, taskHash, sourceHash, workerProgramHash, shimHash,
  transportMount: { type: "volume", source, target: "/tool-rpc", readOnly: true, noCopy: true },
  socketPath: "/tool-rpc/worker.sock",
  supplementalGid: 21000,
  transportPolicy: { deadlineUnixMs, requests, requestBytes, totalRequestBytes, outputBytes },
  supportedIdentityLayouts: [{ uid: 1000, gid: 1000 }, { uid: 10001, gid: 10001 }],
  stdioCommand, // fixed env -i, snapshotted Node source, original nonce and policy
  evidenceScope: "worker-filesystem-only",
  authenticationVerified: false, nativeDiscoveryVerified: false, liveAccepted: false
}
```

The broker chooses the volume, socket, code, and task channel nonce internally.
They are output requirements for a **trusted original native issuer**, not
caller-overridable inputs or independently reusable authority. A copied binding
fails `assertToolWorkerTransportBinding`. The binding hash includes the fixed
shim, original task/source, mount, and nonce. Never forward the host binding,
resource names, code, or nonce as model tool arguments.

The immutable command is exactly:

```js
[
  "/usr/bin/env", "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/scratch", "LANG=C.UTF-8",
  "/usr/local/bin/node", "--input-type=module", "--eval", originalFixedShimSource,
  "--", "--eval-tool-mcp-shim", originalScopeNonce,
  JSON.stringify(binding.transportPolicy)
]
```

For an MCP stdio configuration this is
`{command:binding.stdioCommand[0], args:binding.stdioCommand.slice(1), env:{}}`,
not a shell string or an environment override API. The fixed shim lives at
`evals/harness/tool-worker/mcp-shim.mjs` in the broker source tree; its exact UTF-8
source is snapshotted at module load and sent as the Node `--eval` argument.
No shim file, host directory, or worker workspace is mounted into the candidate.
The mandatory final policy JSON comes only from original worker state. Existing
module instances/bindings retain their old snapshots; adoption of modified code
requires a fresh broker module/process and newly issued originals.

### Synchronous planning-only description

`describeToolWorkerTransportBinding` checks the exact original task/worker/lease/
binding tuple and cached lifecycle, cleanup, cancellation, and absolute expiry.
It performs **no Docker or filesystem I/O**, cleanup, attachment, or admission.
It returns:

```js
{
  kind: "tool-worker-transport-description", protocol,
  task: { invocationId, caseId, client, arm, repeat }, taskHash, sourceHash,
  publicFiles: [{ path, bytes, sha256 }], artifactTargets: ["artifacts/..."],
  limits: { /* copied original local worker caps */ }, deadlineUnixMs,
  binding: originalImmutableBinding, transportBindingHash, workerProgramHash, shimHash,
  planningOnly: true, verification: "cached-original-identity-only",
  freshKernelVerification: false, nativeAdmissionSupported: false,
  evidenceScope: "worker-filesystem-only",
  authenticationVerified: false, nativeDiscoveryVerified: false, liveAccepted: false
}
```

Coordinates, file metadata, target arrays, and caps are copied; contents, host
paths and credentials are never exposed. `binding` is the **original immutable
reference**, not a copy/new authority. Mutating copied descriptions cannot alter
the original state or authorize a caller tuple. Pure builders may use this
identity check; actual broker/native operations must still call the asynchronous
assert before and after their work.

Each asynchronous assert freshly inspects the original worker/container/volume
ownership, confinement, running attachment, deadline and lifecycle. It does
**not** inspect a native consumer, credential custody, catalog, model or login.
There is no native transport attachment/registration/removal API here: the parent
control plane owns the original native consumer and its exact stop/removal.

## Exact tool protocol

Only these model requests exist:

```js
{ op: "read-public", path: "skills/example/SKILL.md" }
{ op: "read-public", path: "inputs/public.txt" }
{ op: "write-artifact", path: "artifacts/report.txt", contentBase64: "..." }
{ op: "read-artifact", path: "artifacts/report.txt" }
```

Paths use canonical `/` wire separators, not host Windows paths. Backslashes,
absolute/UNC paths, dot/traversal segments, empty segments, percent encoding,
nonportable/control/device names, shared-directory case aliases, leaf/directory
collisions, private/grading/expected/credential/config/HOME/proc namespaces,
client instruction/config files, hidden paths, and socket filenames are denied.
Reads must match a declared file exactly; writes/readback must match a declared
artifact target exactly. Content is bounded canonical base64, not a source path.
Skill resources such as code files are **bytes only**, never executable inputs.
The broker must choose already-reviewed public bytes: filename/schema validation
cannot identify private information intentionally mislabeled inside public data.

The broker wraps requests in original-scope, monotonically sequenced records.
Initialization and fixed filesystem/kernel diagnostics use broker stdio;
the Unix socket accepts model requests only, not initialization, diagnostics,
grading, configuration, or capture commands. One socket connection is permitted.
Malformed framing/scope/sequence and cumulative count/byte limits fail closed.

Successful worker responses have `protocol`, `scope`, `sequence`, `ok:true`,
`result:{path,bytes,sha256,contentBase64}`, and the permanently false evidence
flags. Denials have `ok:false`, an explicit `code`, and `diagnosticHash`.
Broker-invalid fields/paths are rejected **before dispatch**. Direct socket
requests receive worker protocol denials; these are not kernel syscall evidence.
No `Skill` event is synthesized or emitted.

Artifacts are opened and read from the original worker disk, not replayed from
requested writes. File descriptors, ancestors, regular-file type, nlink, sizes,
and contents are checked; symlink/hardlink imports are not operations. Capture
returns:

```js
{
  task, taskHash, sourceHash,
  artifacts: [{ path, bytes, sha256, content: Buffer }],
  missing: [/* declared targets absent on disk */],
  captureHash, evidenceScope,
  authenticationVerified: false, nativeDiscoveryVerified: false, liveAccepted: false
}
```

The HOST may later form its own original `captureArtifacts` using those actual
bytes. The worker does not accept or execute checks, expected values, or grading.

## Fixed MCP stdio shim

`mcp-shim.mjs` is fixed transport code, not an ambient MCP configuration. It
implements only JSON-line JSON-RPC2.0 `initialize`, `notifications/initialized`,
`ping`, `tools/list`, `tools/call`, and controlled `notifications/cancelled`,
with three exact tools:

| MCP name | Exact arguments |
| --- | --- |
| `eval_read_public` | `{path}` |
| `eval_write_artifact` | `{path,contentBase64}` |
| `eval_read_artifact` | `{path}` |

Each tool has an object `inputSchema`, required fields exactly as shown,
`additionalProperties:false`, and string properties `path`/`contentBase64`.
The worker additionally enforces its declared namespaces/paths/base64/byte caps.

Unknown methods/tools or extra arguments cannot cause filesystem/shell/code
execution. MCP results are text-encoded worker responses; they are not native
skill catalog, model, login, account, or authenticated custody evidence.
The supported versions are exactly **2024-11-05**, **2025-03-26**, **2025-06-18**.
A supported offer is echoed; another valid dated offer explicitly selects the
latest supported version, **2025-06-18**, never the unsupported offer. Malformed
versions fail. A client requiring a different version must disconnect.

Initialization accepts bounded standard **nonempty** client capabilities:
`roots` (`listChanged` boolean), `sampling` (`context`/`tools` markers),
`elicitation` (`form`/`url` markers), client `tasks` shapes, and bounded
`experimental` JSON advertisements (including inert primitive/array values).
Implementation metadata requires
`name`/`version` and allows `title`, `icons`, `websiteUrl`, and `description`.
Names/versions are at most 128 UTF-8 bytes, title 256, description 1024; at most four
icons, URI 2048 bytes, MIME 128 bytes, eight sizes and light/dark theme. Website/icon
URLs are inert HTTP(S), or `data:image/...` for icons, without URL credentials;
they are never fetched. Capability JSON is at most 4096 bytes and initialization
parameters 8192 bytes, additionally constrained by the original transport caps.
Inert objects have bounded depth 4/members 16/entries 64/arrays 16.

Metadata is validated and discarded, not forwarded to the worker, rendered,
activated, persisted or echoed in diagnostics. Server capabilities remain
exactly `{tools:{listChanged:false}}`. Advertising roots/sampling/elicitation/
tasks does **not** enable those features, resources, prompts, shell, or a model
proxy. Unknown methods return `-32601`; unsupported parameters/action fields
return `-32602` (invalid top-level requests `-32600`). Unsupported notifications
terminate with explicit fixed diagnostics. `_meta`/progress, pagination,
task-augmented requests, custom top-level capability keys, other URI schemes,
undeclared feature methods/notifications and reconnects are not supported.

The worker, lease binding and shim share the **same original absolute
`deadlineUnixMs`**, starting at worker start, including Docker setup time.
The socket survives idle model processing beyond 10 seconds while lifetime remains;
activity, pings, reconnect attempts and initialization never renew that deadline.
Per-operation connection/response waits remain at most 10 seconds, clamped to
remaining original lifetime. Only one connection may be accepted during the
original worker lifetime; it is not replaced after EOF/cancellation. MCP tool
requests share the original request count, raw ingress/output use original byte
caps, and control messages have a fixed bounded eight-message overhead.
Cancellation of an active original tool request closes the transport; known
completed tool cancellations may be ignored, never used to reset authority.
The native client's actual framing/version/initialization compatibility is still
an integration gate, not something this synthetic Node peer proves.

## Supervision and cleanup

Each runtime action rechecks original task/worker/lease scope, the nonce owner
marker, empty Docker config, exact container ID/name/labels, fixed code/image/
environment, socket-volume ownership, actual confinement, and lifecycle.
Actions serialize; busy calls do not create an unbounded queue. Deadline,
cancellation, process failure, excess output, framing failure, and runtime byte/
count limits trigger forced Docker CLI termination and exact `docker rm --force`
of the owned container. Cleanup has a separate bounded deadline and is awaited.
An already-cancelled prepared start performs resource-free owned cleanup only.
Prepared-but-unstarted close removes only its exact nonce directory without
Docker I/O. Start failures await exact owned cleanup; a runtime lease/resolve/
assert failure also awaits cleanup. Invalid original tuples do not authorize
cleanup of any resource.

Cleanup validates exact identity/labels before touching anything and proves
absence of the exact owned container and volume before removing its resolved
nonce directory. There are no broad sweeps, prunes, image deletion, foreign
container removal, or HOME cleanup. A volume held by a running **or stopped but
unremoved** peer/native consumer fails
cleanup explicitly; it is **not** silently detached/deleted. Failure retains
original recovery authority and reports `CLEANUP_FAILED`/`causeCode`.
No cooperative promise alone is counted as completed supervision.

`ToolWorkerError` has fixed sanitized `code`, `failureClass:"infrastructure"`,
and `diagnosticHash`. Runtime failures also carry `taskHash` and verified
cleanup, or explicit cleanup failure. No rejected private value is echoed.
Filesystem reports include task/source/code hashes, selected public-file hashes,
declared targets, caps, actual kernel/confinement diagnostics, counters, and
bounded request/response hashes. These diagnostics never become native proof.

## Validation and one new experiment

```powershell
node --test --test-reporter=tap --test-timeout=20000 C:\Repositories\ai\evals\tests\tool-worker.test.mjs
```

Default tests need no Docker or credentials. They cover strict schema/private
metadata exclusion, originals/clones/cross-task/lifecycle, copied bytes,
portable declarations, actual local symlink/junction/hardlink denials, actual
disk readback, request/file/content/output/deadline caps, and forced local
subprocess cancellation/output cleanup. New protocol regressions include standard
nonempty initialize, inert metadata/features, explicit negotiation/errors,
actual local pipe/socket read before/after 10.5 seconds idle, unchanged original
expiry despite activity/late startup, cancellation/deadline socket closure,
request/output/ingress caps, no reconnect, preparation rollback/recovery, and
cached original-tuple planning metadata. Local registry/pipe fixtures are
explicitly **not native, authentication or Docker containment proof**.
The final targeted run passed **31/31 tests** in 13.67 seconds. Fixture teardown
awaits both socket endpoints and exact nonce-directory removal. Current `.owned`
and `.test-owned` inventories are empty; the follow-up created no Docker
resources and did not replay the settled experiment.

Current fixed sources (these are **not** the historical Docker experiment hashes):

- Worker program SHA-256:
  `119405c7a0960654109e48b0c6f6b40250899e620cd0bde979595fb7dc67acbb`.
- MCP shim SHA-256:
  `ef3defc38eaf80b12a58de664a43c30cbcf4507ea26d627d66635219d0085198`.

The completed Docker experiment below was **not replayed** for these MCP changes.
Its historical command was
`node C:\Repositories\ai\evals\harness\tool-worker\experiment.mjs`;
do not treat current local conformance as a new kernel/native experiment.

The separate bounded experiment creates one new real worker and three exact
owned credential-free Node peers: UID1000 without socket group (kernel EACCES),
UID1000 with GID21000, and UID10001 with GID21000. Synthetic credential canaries
exist only in each authorized peer's separate tmpfs/environment/proc boundary.
The worker is never given those bytes or a canary path/PID/environment override.
Public skill/input read, write/readback, actual host capture, original-handle
denials, and real private/escape/proc/socket/config/import attacks are recorded.
Each denial is labeled host-authority, shim-schema, worker-protocol, or actual
kernel filesystem/socket evidence. Namespace hashes, UID/GID/groups, zero
effective capabilities, no-new-privileges, worker-only environment, readonly
root, and absence of the peer synthetic credential path are measured separately.

Timestamped `experiment-evidence-*.json` lives beside this harness, **outside
shipped skills/plugins**, and contains hashes/explicit outcomes plus exact
cleanup. Failed/unsupported primitives are persisted as explicit error evidence,
not accepted proof. Inspect the recorded evidence rather than assuming the
experiment succeeded because unit tests passed.

### Recorded 2026-10-09 result

`experiment-evidence-1791553763847-4d78e620-d483-417a-b0d6-6a6c7686d7a0.json`
records the completed worker-only experiment. Evidence hash:
`5f3c2ec5a60f26b9be89a99c48b16e7fa4e986563b892c08d95eab03a615c414`.
Its worker program hash was
`521090f7f0b1ac27e032a4df55724836d57b9b4f32b2cf3cf76aee53742db032`;
its shim hash was
`10deea2bde97f31c3375ea25d9bbc70f1492e1c3a73dfe63e6d2349a5d3c01f2`.
Those measurements predate the startup/lifetime changes above.

- 15 default tests passed. The actual experiment had 26 dispatched filesystem
  requests: positive read/write/readback plus 17 worker-protocol denials.
- Five more denials were at the fixed MCP schema/tool boundary, five at host
  original-handle authority, and unauthorized socket connection produced actual
  kernel `EACCES`.
- Both actual peer UID/GID1000 and10001 were preserved. Their PID/mount/network
  namespace hashes differed from the worker; **user namespace hashes did not**.
  The worker was UID/GID10002, with only LANG/PATH/TMPDIR environment, zero
  effective capabilities, no-new-privileges, actual readonly overlay root and
  tmpfs workspaces. Peer synthetic credential paths were absent in the worker.
- Actual disk capture returned a 61-byte artifact with SHA-256
  `1a586431b3831815dd50c4715339360ebc87c20df9dad329570f835abda817e6`.
  No grading, native client, native discovery, authentication, or provider ran.
- Original-handle cleanup proved the exact worker, socket volume, all three
  peer containers, and their nonce directories removed. `.owned` and test nonce
  inventories were empty afterward.

An earlier **pre-start setup failure**, retained in
`experiment-evidence-1791553508546-e2c10c7c-4491-4093-92bf-0e2f65be28f6.json`,
exposed Docker's omitted false `HostConfig.Mounts[].ReadOnly` field and lowercase
absence text. The worker process never started in that attempt. Exact recorded
owned startup resources were subsequently checked and removed; that recovery
is explicitly **not public-API serialized-handle authority or successful
original-broker cleanup**. The complete experiment above uses the corrected
metadata/absence handling and verified original-handle cleanup. Absence case
handling now has a default regression test.

## Remaining native integration gates

1. The original native control plane must bind the original evaluation task,
   source snapshot, candidate handle, and worker lease together. Plain task
   coordinates or copied mount/command reports must not grant native authority.
2. The selected pinned native builder must mount **only** the original socket
   volume readonly, preserve its actually observed UID/GID1000 or10001, add
   GID21000, and launch the fixed shim in a cleared environment. No socket
   address, volume, command, code, URL, or image-ID overrides may be accepted.
3. Native arbitrary built-in read/write/file/shell/eval tools must be disabled.
   Enable exactly this explicit controlled MCP transport, with ambient MCPs,
   client config imports, plugins/hooks, and permission broadening disallowed.
   If the pinned native client cannot enforce this, fail closed.
4. Every native runtime/action/cleanup must recheck the original transport
   binding and join native consumer removal to worker deadline/cancellation.
   Synchronous descriptions are cached planning identity, never kernel freshness.
   Stop/remove the exact native consumer before socket-volume cleanup. This
   module intentionally does not issue/own native candidate handles.
5. Measure actual native discovery/catalog/Skill loading independently. A worker
   `skills/.../SKILL.md` read or MCP `tools/list` is **not native Skill loading**.
6. Observe normal native authentication, model invocation, direct-provider
   custody, and required private-userns policy independently. No live run,
   authenticated acceptance, provider traffic, or native evidence is enabled by
   this prototype.

No existing client builders, authentication lanes, CLI/live schedulers,
contracts, native image manifests, permissions, or global configuration are
modified by this slice.
