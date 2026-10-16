# Actual OpenCode offline client adapter

This additive adapter exercises **OpenCode 1.14.28**, not a simulated client.
Probe receipts use `transport: "offline-mock/not-live"` and
`modelQualityEvidence: false`. Only inference is scripted; discovery, skill
loading, file reads, permissions, tool errors, and machine events are the real
client's behavior. This does not approve a real provider, model baseline, paid
smoke test, or live credential/egress boundary. The existing isolation live guard
is unchanged and still blocked.

## Mock-free native broker primitives

These additive APIs prepare or observe the **normal pinned native client**.
They do not run login/status/model calls, issue an authentication lease, admit a
provider/model, attach a candidate to egress controls, or approve live execution.
The continuation was validated with **units only**; no new native image build,
native task, old probe/matrix replay, account operation, or inference was run.

### Case-free image ownership

The client index exports these **async** host functions:

```javascript
const imageHandle = await prepareNativeRuntimeImage({ timeoutMs: 180000 });
const image = await describeNativeRuntimeImage(imageHandle);
await assertNativeRuntimeImage(imageHandle, {
  client: 'opencode', clientVersion: '1.14.28', image: image.image
});
// Stop independently owned candidates before releasing their SDK image.
await cleanupNativeRuntimeImage(imageHandle);
```

Preparation accepts only `timeoutMs` (1000–300000 ms), not cases, mock answers,
private checks, credentials, Docker commands, profiles, or caller proof flags.
It creates an opaque `{id,client}` original WeakMap handle. Serialized/copied
handles are rejected. Describe/assert return the observed immutable image ID,
base/package pins, public dependency image, actual inspected platform/engine,
manifest hash, image `user`/`workdir`, binary/helper paths and
`status: "prepared" | "released"`.
`authenticationVerified`, `containmentVerified`, and `liveAccepted` stay false.
Assert is a process-owned handle/pin check, **not** current candidate inspection,
executable adoption, authentication, or live admission.

The public package-only context contains exactly the Dockerfile/package/lock
manifests. Exact package pins, public registry URLs, lock integrity declarations,
cached base digest and engine/platform are checked. The install stage asserts
OpenCode 1.14.28 and Node 22.22.1 before caller bytes exist. Only this public
restoration stage can use build networking. `Dockerfile.native` receives fixed
helper sources in a separate network-none build; it has no scripted inference
server, fake provider configuration, task fixtures, or grader declarations.
Its normal executable is
`/opt/client/node_modules/opencode-linux-x64/bin/opencode`.
Preparation starts no candidate. The existing offline task uses the same
factored build/ownership helpers with its separate offline helper image.

Cleanup rechecks owner labels and immutable image IDs, refuses retargeted or
foreign resources, removes only the two owned image tags and workspace, and
verifies absence. It does not remove another broker's containers. Concurrent
release is coalesced; successful release is idempotent. An image still used by a
candidate causes explicit cleanup failure rather than forced unrelated removal.

### Pure native specification

`prepareNativeTaskSpecification(payload,{model,limits,authRoot,proxyURL,toolTransport})` is
synchronous and performs no filesystem/network/process operations.

- `payload = {task,prompt,skill,inputs=[],artifactTargets,timeoutMs=180000}`.
  Coordinates, bytes, standalone `SKILL.md`, no-skill handling, roots,
  collisions/aliases, namespace poisoning and caps use the common validators
  factored out of offline mock admission. `checks`, `mock`, host imports,
  credential values, caller environments and authentication flags are rejected.
- `model` is the broker's requested `"provider/model"` or
  `{providerID,modelID}`. It is not an observed or admitted model. Configuration
  enables that native provider and selects it for both model slots; it contains
  **no** fake provider, API key, custom npm SDK, baseURL or scripted answer.
- `authRoot` is an optional intended container **XDG data location** under
  `/work/data` or `/work/auth`, not a host path, credential/root descriptor,
  custody handle, verified store layout or mount authorization. Default data
  is `/work/data`; HOME/config/cache/state/scratch remain fresh explicit roots.
- `proxyURL` is an optional credential-free local/owned `http://host:port`
  CONNECT endpoint. All upper/lowercase HTTP/HTTPS/ALL proxy variables use it;
  upper/lowercase NO_PROXY are empty. Native proxy handling and actual attachment
  remain unverified. No provider endpoint or TLS connection is replaced.
- `limits` accepts `timeoutMs`, `nativeOutputBytes` (1–2097152 bytes), `maxTurns`, `maxTokens`, `maxInputTokens`,
  `maxOutputTokens`, `maxUsd`, `maxCredits`. Only a bounded supervisor timeout
  and existing byte/resource plans are described. Requested native token/turn/
  billing hard caps remain **null/unsupported**, produce blockers and never
  become invented CLI flags or agent settings.
  `nativeOutputBytes` describes `limits.supervisor.stdoutBytes` and bounds
  evidence parsing; it is not a native token cap or proof of applied runtime
  supervision.

Returned fields are `format`, `client`, `clientVersion`, `task`, `model`,
`binary`, `cwd`, `args`, `stdin`, `config`, `env`, `materialization`, `seeds`,
`skill`, `artifactTargets`, `layout`, `runtimePins`, `helperPaths`, `auth`,
`network`, `plugins`, `limits`, `blockers`, `status` and the three false
auth/containment/live flags. The normal argv is
`run --pure --format json --model <selector> --title "Owned native evaluation task"`;
the prompt is separate stdin, never a positional option or attachment.
`stdin.submittedHash` and `framedInputHash` hash supplied bytes;
`stdin.observedWireHash` is **null**. The known one-newline envelope is pinned
source/offline evidence, not observation of encrypted live provider traffic.

Pinned native source confirms `--pure` excludes **external** plugins, but the
six internally imported account-auth plugins still initialize. Native
specifications explicitly retain that route rather than applying the offline
default-plugin-disable setting. Their normal-account compatibility, refresh,
hooks/tool boundary and actual plugin catalog are **unverified**; empty `plugin`
does not mean no internal native plugin code runs.

The intended candidate layout retains UID1000, readonly rootfs and the existing
256 MiB noexec/nosuid/nodev `/work` tmpfs. This is not proof that the separate
network controller (currently UID10001) can adopt the native image/executable or
attach this layout. Those original-handle image/UID/attachment facts remain
outer-broker blockers, as do authentication and account quotas.
Initial helper workdir is `/opt/fixture`; materialization requires absent project/
HOME directories. Only after materialization does the broker select the native
task cwd `/work/project`. Starting helpers with that cwd would create the project
directory prematurely; the native image deliberately does not use it as its
initial workdir.

### Optional original tool-worker transport: planning-only spec

`toolTransport` is optional and must contain exactly `{task,worker,lease,binding}`,
the original process-owned values. Shared client-local validation
(`native-tool-transport.mjs` over the claude-code helper) uses the public synchronous
original descriptor and rejects copies/foreign handles, coordinate/source/target/hash
drift and terminal or expired originals before any spec is built. Without the option the
specification is byte-for-byte unchanged. The prompt/stdin envelope is never altered.

With a valid tuple the spec gains `toolTransport` (no worker/lease handles) and:

- `config.mcp = {eval_tools:{type:'local',command:<binding.stdioCommand>,environment:{},enabled:true}}`
  (the `mcp` key and local schema are from the pinned `config/mcp.ts`).
- `config.permission` = `'*':'deny'`, `skill:{'*':'deny',<id>:'allow'}` (omitted for no-skill)
  and `allow` for exactly `eval_tools_eval_read_public`, `eval_tools_eval_write_artifact`,
  `eval_tools_eval_read_artifact` (`sanitize(server)_sanitize(tool)` in `mcp/index.ts`).
  Native read/edit/external_directory grants are dropped; Skill stays the native tool.
- `OPENCODE_PERMISSION` (same JSON; merged by `Config.loadInstanceState` after the
  active-organization and managed sources) and `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
- `--pure`, XDG/HOME/`OPENCODE_DB` isolation and provider/model syntax are unchanged.

**Source limitation, not a measured result.** In v1.14.28 well-known auth entries
(`auth.json` type `wellknown`), an active Console account organization and the managed
config directory are merged after inline config. They are absent in a fresh owned
data/DB/image, but the harness cannot inspect credentials. If one is present it could
add MCP servers or agent-level permissions (`Agent.state` merges
`agent.<name>.permission` after global permission), which `OPENCODE_PERMISSION` cannot
override. No supported flag disables these sources, and `--pure` does not. The spec
therefore lists blockers and `requiredObservations` (effective MCP keys equal
`eval_tools`, no late account/well-known/managed source, no agent override, catalog equals
Skill + three tool ids, real Skill/tool use) and keeps `nativeAdmissionSupported`,
`nativeDiscoveryVerified`, `authenticationVerified`, `freshKernelVerification` and
`liveAccepted` false. It is not proof of MCP consumption or Skill loading; the fixed
60 s worker deadline includes startup. Worker-filesystem capture/grading stays with the parent.

Test: `node --experimental-test-module-mocks --test tests/clients-opencode-sterile-tools.test.mjs`
(wiring doubles only; the shared wiring test must be updated for OpenCode).
### Fixed filesystem and native-state readers

The image supplies these fixed trusted helpers, not model tools or alternative
clients:

| Helper | Bounded stdin | Result |
| --- | --- | --- |
| `node /opt/fixture/task-files.mjs` | `{operation:"materialize"|"inventory",manifest:spec.materialization}` | `opencode-native-disk-evidence-v1`, task copy, readonly seed hashes and declared-only disk inventory |
| `node /opt/fixture/native-session.mjs` | `{sessionId:"ses_..."}` | `opencode-native-session-snapshot-v1`, projected actual session/model/input/part hashes and counters |
| `node /opt/fixture/task-capture.mjs` | Existing `{protocol:1,executionId,inventory}` | Original selected filesystem bytes, never native/model stdout artifacts |

Materialization requires fresh project/HOME roots, creates explicit bytes with
0444/0555 modes, seals source directories, leaves only necessary output creation
parents writable and checks both workspace/HOME for undeclared files. This
retains native exact-path permission enforcement; directory writability is not
an independent OS-level per-filename ACL. The broker owns actual runtime
resource application and must stop native processes before inventory/capture.

Native configuration pins `OPENCODE_DB=/work/state/opencode-native.db`, supported
by the pinned native database path selector. The reader uses Node's readonly
SQLite API and the pinned `session`, `message`, `part` tables, never bootstrap,
login, auth storage, HTTP or native model execution. It validates native version,
session/directory/parent/message identities, rejects links/nonregular databases
and sidecars, uses a read transaction and bounded rows/bytes, and detects main
database replacement/change. Limits are 16 MiB per database/sidecar, 512
messages, 8192 parts and 2 MiB decoded records. Its result contains no raw prompt,
completion, skill/tool transcript or session title. Only IDs, native models,
input/part hashes and native reported counters/cost estimates are projected.
Unsupported/missing state or reader capability fails explicitly. Actual pinned
post-auth state compatibility has **not** been executed in this continuation.

### Conservative native observations

The synchronous signature is:

```javascript
parseNativeTaskEvidence({
  spec, nativeResult: { stdout, exitCode, timedOut?, cancelled?, clientVersion?, elapsedMs? },
  sessionJSON?, sessionSnapshot?, skillCatalogJSON?, diskEvidence?, capture?
});
```

`sessionJSON` is bounded pinned native `export` format `{info,messages}`.
The parser requires the **original** frozen specification returned in this host
process; copied/serialized specs are rejected. The original specification still
grants no execution/admission authority. Retain `materialization`, `model.selector`,
`limits.requested`, `auth.intendedDataRoot`, `network.intendedProxyURL` and
`stdin.{submittedHash,framedInputHash,envelope}` unchanged: complete canonical
spec integrity, native session/directory/part identities and actual stored input
hashes bind the observation. Serialize only explicit public manifests when
staging helpers; keep the original host spec/capture for observation/grading.
`sessionSnapshot` is the fixed reader's projected format; supply at most one.
It must match the native JSONL session and every emitted part hash/message ID.
Observed model/provider come only from matching native **assistant-message
metadata**, not submitted model, completion prose or a requested-model echo.
They are native client observations, not vendor attestation. Raw native stored
user text supplies a separately checked caller-span/message/envelope hash.
Sanitized exports retain model metadata but redact input; their observed input
hash stays null with an explicit blocker, never copied from the expected hash.

`skillCatalogJSON` optionally parses pinned `Skill.Info[]`
`{name,description,location,content}` from an independently broker-captured native
registry. The selected root/content or actual empty no-skill catalog is checked.
This does not observe advertised provider tools, resolved config, MCP or plugin
registries. Those remain null and `catalog.complete` stays false.

The result includes:

- `model:{requested,requestedProvider,observed,provider,requestedSelector,
  observedSelector,nativeRequestedSelector,provenance}`; missing native state
  leaves observed fields **null**, which is diagnostic data, not admission.
- `prompt:{submittedHash,submittedEnvelope,nativeObservedHash,nativeMessageHash,
  envelope,provenance,wireMessageHash:null,providerWireObserved:false}`.
- `catalog:{complete:false,skills,tools:null,config:null,mcp:null,plugins:null,
  skillCatalogHash,skillsProvenance,usedTools,usedToolsProvenance}`.
- `trigger:{loaded,evidence,attempted,failedCalls,absenceVerified:false,provenance}`.
  Loading requires the genuine completed native Skill wrapper/body/title/name/
  directory/truncation metadata. Full negative discovery is not invented.
- V2-shaped `usage` with exactly `inputTokens`, `outputTokens`, `elapsedMs`,
  `usd`, `credits`, each `{value,provenance}`. Present native step counters are
  client-reported; missing counters/time are null. Cost estimates are separate
  native diagnostics, **not** billed USD/credits; billing fields stay null.
- Bounded `nativeTrace`, incomplete full `audit`, explicit `blockers`, and false
  authentication/containment/live flags. `capture`, when supplied, is the
  **original host handle**, not cloned or graded here; shared host WeakMap
  validation and deterministic grading remain the parent's responsibility.

Incomplete native execution, malformed/mismatched metadata, successful forbidden
tools/paths or changed seeds throw explicit infrastructure errors. Relative
native Read/Write/Edit paths resolve against the fixed Linux cwd and must still
match exact grants. Completed `apply_patch` currently has no supported path audit
and fails explicitly. No inference schedule, canned completion marker, HTTP
interception, credential bytes or private grader declarations are required.
Native JSONL cannot count hidden encrypted provider requests/retries or establish
whole-account quota/usage coverage. Those remain explicit independent blockers;
completed emitted steps are not proof of a no-retry policy or a total-token cap.

Pinned source references used for format—not live proof:
[run](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/cli/cmd/run.ts),
[messages](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/session/message-v2.ts),
[export](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/cli/cmd/export.ts),
[database](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/storage/db.ts),
[tables](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/session/session.sql.ts),
[skills](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/skill/index.ts),
[plugins](https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/plugin/index.ts).

## Parameterized native task API

The additive **async** `runOfflineTask` export executes a caller's selected case,
not the fixed `runOfflineProbe` demonstration. Its transport is `offline-mock`.
No task receipt is authenticated/live acceptance, a baseline approval, or a
deterministic-v2 evaluation result.

**New parameterized native tasks passed on 2026-10-08.** Three fresh actual
OpenCode 1.14.28 cases exercised a non-demo selected skill, arbitrary unique
prompts, caller string/Buffer fixture bytes, selected nested artifact creation,
negative loading, and a no-skill/not-found control. Native permissions, complete
tool/provider audits, trusted filesystem readback, host-only grading, retained
captures, and scoped cleanup were verified. This is offline capability evidence
only. `task-evidence.json` contains the bounded factual receipt snapshots.

Initially missing public installation layers were restored in a separately
authorized **package-only public build** before any caller/skill/check bytes
were attached. The helper build and every candidate execution remain offline.
No old fixed probe, raw-model substitute, credentials, or model/vendor inference
was used to obtain this new-task evidence.

```javascript
import { runOfflineTask } from './evals/harness/clients/opencode/index.mjs';
import { readCapturedArtifact } from './evals/harness/checks/index.mjs';

const receipt = await runOfflineTask({
  task: {
    invocationId: 'dispatch-47', caseId: 'ion-ferry', client: 'opencode',
    arm: 'candidate', repeat: 1, fixtureHash: 'c'.repeat(64)
  },
  prompt: 'Consult packet-almanac-47 and write results\\dispatch.txt.',
  skill: {
    id: 'packet-almanac-47',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: packet-almanac-47\ndescription: Ion ferry dispatch guidance\n---\nUse the ion ferry routing reference.\n'
      },
      { path: 'references\\routing.txt', content: Buffer.from('Route blue-gamma.\n') }
    ]
  },
  inputs: [
    { path: 'briefing\\order.txt', content: 'One ion ferry.\n' },
    { path: 'AI\\inventory.md', mountRoot: 'home', content: 'Ion ferry available.\n' }
  ],
  checks: [
    { id: 'carrier', class: 'correctness', type: 'artifact-contains',
      target: 'results\\dispatch.txt', expected: 'carrier=ion-ferry-47' },
    { id: 'private-absent', class: 'safety', type: 'artifact-not-contains',
      target: 'results\\dispatch.txt', expected: 'HOST_ONLY_PRIVATE_LITERAL' }
  ],
  // Explicit SCRIPTED LOCAL INFERENCE fixture, not a model, grader, or inferred answer key.
  mock: {
    loadSkill: true,
    artifacts: [{ path: 'results\\dispatch.txt', content: 'carrier=ion-ferry-47\nroute=blue-gamma\n' }]
  },
  timeoutMs: 180000
});
const nativeBytes = readCapturedArtifact(receipt.capture, 'results\\dispatch.txt');
```

The signature is
`runOfflineTask({task,prompt,skill,inputs=[],checks,mock,timeoutMs=180000})`.
Task coordinates are required and copied unchanged; `fixtureHash` is the caller's
64-lowercase-hex identity, not an adapter assertion that an entire suite was
exported. The adapter separately hashes each supplied seed and the actual wire
prompt. Candidate/baseline arms require a genuine named `SKILL.md`; no-skill
requires `skill: {id, files: []}`. The native parser remains authoritative for
frontmatter interpretation; preflight checks the required bounded name,
description, and nonempty body.

Inputs accept **only** explicit `{path,content:string|Buffer,executable?,mountRoot?}`
agent-visible fixture bytes. `mountRoot` is `workspace` by default or explicit
`home`; there is no host-directory import or magic `home\` prefix. Inputs are
materialized at `/work/project` or synthetic HOME `/work/home`; the selected
skill is materialized at `.opencode/skills/<id>`. Windows separators are
normalized only for native paths, while original host check targets are retained.

**Private grading is host-only.** `validateChecks`, `captureArtifacts`, and
`gradeChecks` run on the trusted host. Only deduplicated artifact target
**strings** cross into the container. Check declarations, `checks.expected`,
private specimens, and their bytes never enter the native manifest, provider
request, configuration, or scripted inference server. Mock artifact content is
copied from the explicit public fixture, never derived from checks/specimens.
Opaque caller bytes cannot be classified as secret automatically: callers must
select only agent-visible synthetic/exported inputs.

### Native execution and receipt

Every call gets a new trusted UUID execution ID, workspace, container,
HOME/config/data/cache/state, and actual native session. The exact caller prompt
is delivered through native stdin, never parsed as a CLI option. Pinned 1.14.28
quotes/escapes space-bearing positional arguments and prepends one newline to
stdin-only messages. The provider audit therefore requires exactly
`"\n" + callerPrompt`, verifies that sole native envelope, and computes
`promptHash` from the **observed caller span** after the one framing newline.
Each request also records `wireMessageHash` for the full native message and
`promptEnvelope: "opencode-1.14.28-stdin-newline"`. Leading hyphens, quotes,
backslashes, and newlines are covered by the actual acceptance; arbitrary
substring matching or a report-only prompt hash is not accepted.
The completed receipt exposes both fields at the **top level**, copied from
the first actual provider request only after the full strict audit verifies
the same framing/hash across every request. They also remain available in
`receipt.audit.requests`; no prompt/check-derived fallback fills missing fields.
The same Anthropic SSE scripted protocol is shared with the probe;
there is no client fork, replacement tool implementation, executable task DSL,
provider service, or AI grader. Caller-provided non-executable AGENTS documents
are explicit task data (the native client may include their text as
instructions); they do not change the fixed provider/tool policy. No personal
instructions are inherited.
Task configuration also explicitly disables native formatters, language
servers, Git snapshots, and automatic compaction/pruning. These pinned supported
settings prevent generic source/config fixtures from invoking an automatic
formatter/LSP subprocess outside the declared tool surface, preserve caller
artifact bytes, and keep the finite tool-feedback history intact.

The script requests the selected skill (when requested by the public mock),
complete native reads of provided fixtures and selected skill files, and native
`write` creation using the caller's explicit artifact bytes. It additionally
records protected proc/private/sentinel reads, shell/network tools, and protected
source/HOME/config/unselected-artifact write denials. Seed files are `0444`
(or `0555` when explicitly executable); source directories are sealed read-only
unless a directory must create a declared output. Write permissions always deny
all except exact declared targets. Necessary output-creation directories and
native client state are writable; this is not an OS-level per-filename write
ACL independent of the verified native tool policy.
Protected-file canary/sentinel values are bound to the fresh trusted execution
ID, not fixed public probe literals. Caller fixture/artifact text may legitimately
contain those old public literals without being misclassified as disclosure;
the actual per-call protected values must never reach native events or provider
feedback.

The host reparses the full native event stream, binds every tool event to actual
subsequent provider feedback, checks the finite request/call sequence, verifies
seed integrity and disk inventory, and captures only declared files from the
completed native filesystem. Assistant completion text and tool stdout are
**not** artifacts. Missing/malformed audit, nonterminal execution, drift,
unexpected tools, failed intended reads/writes, disclosure, failed protected
denials, or capture/cleanup errors throw explicit infrastructure errors.
There is one native attempt and no automatic retry.

`trigger.loaded` is derived from the actual completed native `skill` event,
its skill directory/name metadata, genuine skill-content wrapper/body, and
observed tool feedback. A scripted `loadSkill:true`, candidate prose, request
intent, or a successful Write is not a skill load. Full audited absence supplies
discovery-audit evidence for `loaded:false`; missing audit is an error, not
silently `false`. `loadSkill:true` with the no-skill arm observes the real
not-found failure while independently creating public canned outputs.
When a case has no allowed Read paths, the pinned native client removes Read
from the provider tool surface. Protected Read attempts then produce audited
`unavailable`, not invented permission-denial outcomes. Unavailability is
accepted only when the actual tool surface omits that tool throughout the audit.

Docker's archive/cp interface cannot see the `/work` tmpfs in this pinned
environment. After the native process group exits, the supervisor verifies an
owned pause barrier and invokes a **fixed trusted filesystem reader** from the
immutable helper image, not the candidate or a second native session. It reads
only declared targets, rejects links/nonregular files and inventory changes,
rechecks byte lengths/hashes, seals captured output files, and transports their
exact disk bytes on a separate owned Docker-exec capture channel. The host
revalidates those bytes before `captureArtifacts`/`gradeChecks`. Native CLI/model
stdout and assistant text are never used as artifacts or substituted for files.

The immutable receipt includes:

```javascript
{
  client: 'opencode', clientVersion: '1.14.28',
  executionId: '<fresh trusted UUID>', task: {/* exact copied coordinates */},
  promptHash: '<SHA-256 of observed caller span in the exact native wire envelope>',
  wireMessageHash: '<SHA-256 of full observed native wire message>',
  promptEnvelope: 'opencode-1.14.28-stdin-newline',
  image: 'sha256:<observed immutable built image ID>',
  transport: 'offline-mock', offlineEvidenceOnly: true,
  authenticationVerified: false, liveAccepted: false,
  status: 'completed', fresh: true,
  runtime: {/* observed client/Node/ripgrep/image/engine/platform, synthetic auth only */},
  trigger: { loaded: true, evidence: [/* skill-load + full discovery-audit refs */],
             attempted: true, failedCalls: 0 },
  audit: {/* complete actual native events, bounded wire hashes/feedback/discovery, seed/disk hashes */},
  artifacts: [/* capture metadata, including explicitly missing targets */],
  capture: {/* original trusted in-process immutable capture handle */},
  checks: [/* gradeChecks(...).checks: passed/failed/error outcomes */],
  checkEvidence: {/* gradeChecks(...).evidence */},
  artifactReadback: { source: 'trusted-native-filesystem',
    transport: 'owned-docker-exec-filesystem-reader', files: [/* disk inventory */],
    verified: true },
  elapsedMs: 1234, nativeElapsedMs: 567,
  usage: {
    inputTokens: { value: null, provenance: 'unavailable' },
    outputTokens: { value: null, provenance: 'unavailable' },
    elapsedMs: { value: 1234,
      provenance: 'supervised-host-monotonic-clock-including-build-and-cleanup' },
    usd: { value: null, provenance: 'unavailable' },
    credits: { value: null, provenance: 'unavailable' }
  },
  cleanup: { container: 'removed', image: 'removed',
             publicDependencyImage: 'removed', workspace: 'removed',
             owner: '<executionId>', verified: true }
}
```

Failed hard checks remain factual `failed` outcomes on an otherwise completed
native execution; they do not rewrite the native status. Existing unsupported
`trace-event`/`manual-evidence` checks remain explicit grading errors. The capture
retains immutable exact bytes after owned workspace/container/image cleanup,
and remains usable with `readCapturedArtifact`/`gradeChecks` in this host process.
Serialization cannot recreate its trusted WeakMap identity. Receipts do not
dump the raw prompt, HTTP headers, auth config, or native stderr; tool events
contain only the explicitly supplied agent-visible/canned data and synthetic
denial observations. Synthetic SSE token counters are not real token/billing
usage: input/output tokens, USD and credits stay unavailable/null, not zero.
Native infrastructure errors expose bounded classifications and hashes, not
raw native error messages that might repeat a prompt.

### Admission, confinement, and new task acceptance

Before any launch, admission rejects extra fields/imports, traversal/absolute
paths, glob metacharacters, nonportable device names, trailing dots/spaces,
case-insensitive directory/file aliases, ancestor collisions, seeded output
collisions, private grader namespaces/specimen names, credential files,
automatic client configuration/hook/plugin/discovery stores, and undeclared mock output paths.
Path components use portable ASCII letters/numbers/spaces/dot/underscore/hyphen.
Nested declared targets are supported and verified by actual native creation
and disk readback. Both fixture roots may intentionally use the same relative
basename.

Caps: 64 skill+input files, 16 KiB per seed, 1 MiB aggregate seeds, 64 KiB prompt,
128 checks/1 MiB host-only declarations, 16 declared targets,
64 KiB per canned artifact/256 KiB combined,
160 native calls, 160-character relative paths, 2 MiB wire/native event stream,
2 MiB serialized native manifest (checked before launch), 128 KiB native stderr,
4 MiB Docker command output, and 1–300 seconds per task
(default 180). Up to four task calls execute concurrently; the deadline covers
queueing/build/native execution/capture. Cleanup commands have separate
10-second deadlines. Native text Read must complete without truncation;
unsupported binary/multimodal Read feedback or native parse/read failures are
explicit infrastructure failures, not fabricated successful byte exposure.

A task first builds the existing public `install` stage with
`--target install --network default --pull=false`, the cached digest-pinned
Node base, and locked public client packages. That context contains **only**
`Dockerfile`, `package.json`, and `package-lock.json`; no helpers, prompt, skill,
fixtures, checks, private specimens, or host credentials enter the public
restore stage. The helper-only runtime image is built from the observed owned
public dependency image with `--network none --pull=false`; it contains no
case/grader bytes. The dependency tag is rechecked against its immutable
observed image ID. Runtime manifests carry only explicit public case data and
artifact target strings; private check declarations remain in host memory.

A completing receipt must observe Docker 29.7.2, Linux/amd64, Node 22.22.1,
OpenCode 1.14.28, and ripgrep 15.0.0. The new actual tasks observed all these
versions plus immutable runtime/dependency image IDs. Each execution uses
the observed immutable image ID, network `none`, read-only rootfs, nonroot
1000:1000, all capabilities dropped, no-new-privileges, 128 PIDs, 768 MiB RAM
with no extra swap, one CPU, no Docker logs, and a 256 MiB noexec/nosuid/nodev
owned `/work` tmpfs. There are no host mounts. Native HOME, config, PATH and
provider configuration are constructed from fixed values, not inherited.
Open-file and process-file limits are bounded at 256 and 16 MiB respectively.
The file limit accommodates native SQLite/WAL state; the independent selected
artifact caps remain 64 KiB each/256 KiB total. An initial 1 MiB process-file
limit caused a genuine SQLite disk-I/O failure and was corrected without
loosening Read/Write permissions or introducing a retry.
The host Docker CLI also uses an owned empty config/HOME, a fixed local daemon
endpoint, and installed executable/fixed PATH rather than personal auth/config.
Its generated config contains only the installed trusted CLI-plugin directory;
`DOCKER_BUILDKIT=1` forbids legacy fallback. It never imports a personal Docker
config or copies credentials.

Poison seeds are blocked at automatic HOME/workspace configuration/discovery
roots, including root `opencode.json`/`.jsonc`/`.mcp.json`, `.opencode`
plugins/skills, `.claude` settings/hooks, `.copilot`, `.agents`, `.github`,
`.config`, `.local`, and `.git`. Readonly bytes alone are not the defense against
auto-loaded plugins/hooks. Ordinary non-executable explicit documents such as
`docs\opencode.json`, `docs\example.json`, `AGENTS.md`, and HOME `AI\local.yaml`
remain data/readable fixtures; their text cannot override the constructed
deny-all policy or enable a provider. Credential and grader-private namespaces
are prohibited independently of the root distinction.
Automatic root `.gitconfig` and Git/SSH/cloud credential stores
(`.ssh`, `.aws`, `.azure`, `.gnupg`, `.npm`) are rejected too; explicitly supplied
Git trust/fsmonitor or SSH proxy commands cannot become ambient configuration.

Run **only the new task acceptance**, not the old fixed probe:

```powershell
$env:EVAL_CLIENT_OPENCODE_TASK_DOCKER='0'
$env:EVAL_CLIENT_OPENCODE_DOCKER='0'
node --test --test-reporter=spec C:\Repositories\ai\evals\tests\clients-opencode-tasks.test.mjs C:\Repositories\ai\evals\tests\clients-opencode.test.mjs
node --test C:\Repositories\ai\evals\tests\clients-opencode-tasks.test.mjs
$env:EVAL_CLIENT_OPENCODE_TASK_DOCKER='1'
node --test C:\Repositories\ai\evals\tests\clients-opencode-tasks.test.mjs
```

The opt-in test uses unique actual prompts, a non-demo target skill with caller
string/Buffer companion/workspace/HOME bytes, nested caller artifacts, an
audited negative-loading baseline arm, and a fresh no-skill/not-found control.
It checks actual wire hashes, native load/read/create events, private-key
nonexposure, selected outputs/denials, host grading (including deliberate failed
and unsupported checks), distinct sessions, and retained captures after scoped
cleanup. `ACTUAL_OPENCODE_TASK` output is bounded factual metadata, not model
quality or live acceptance. No paid/vendor inference call, login/status command,
credential read/import, host/global config/firewall change, autotrust, or commit
is performed.

Current verification: **18 unit tests passed** in the combined
new-task/preserved-probe selection, with opt-in native tests explicitly skipped.
The new task file alone passed **13 tests**, including the opt-in scenario trio.
New-task tests cover admission/poison seeds, exact private-host/public-native
separation, independent canned bytes, local SSE protocol, bounded native error
diagnostics, trusted selected-file readback, and original host capture identity
after scoped directory cleanup. Actual cases recorded:

| Case | Native calls / provider requests | Actual load | Host checks |
| --- | --- | --- | --- |
| Candidate `packet-almanac-47` + companion/workspace/HOME inputs + nested `results\flight-manifest.txt` | 22 / 23 | true | 4 passed |
| Baseline negative-load + selected `message.txt` | 18 / 19 | false, not attempted | 1 passed |
| Fresh absent-skill control + nested `notes\control.json` with preserved noncanonical spacing and arbitrary public fixture-marker text | 15 / 16 | false, genuine not-found | passed / deliberate failed / unsupported error |

All three had distinct trusted execution IDs/native sessions and immutable
observed image metadata. Omitted outputs, protected Read/tool/Write denials,
exact caller artifact bytes, retained post-cleanup captures and explicit grading
failures were verified. `task-evidence.json` records bounded actual receipt,
seed/output hash, denial, usage and cleanup metadata—not full prompts, headers,
private declarations, or model quality. The old fixed probe was **not rerun**.
The earlier exact failed legacy build container was removed only after matching
its recorded ID, parent image, command, and start time. Each task removes only
its label-matched container, runtime/dependency tags, and marked workspace.
Ordinary build cache remains; there is no Docker prune or shared/global cleanup.

For a single targeted receipt-framing regression, without rerunning the trio or
the fixed probe:

```powershell
$env:EVAL_CLIENT_OPENCODE_TASK_DOCKER='0'
$env:EVAL_CLIENT_OPENCODE_DOCKER='0'
$env:EVAL_CLIENT_OPENCODE_TASK_FRAMING_DOCKER='1'
node --test --test-reporter=spec --test-name-pattern='one native task returns top-level audited framing' C:\Repositories\ai\evals\tests\clients-opencode-tasks.test.mjs
```

This one actual task verifies both top-level observed framing fields, exact
caller-span hash, original trusted post-cleanup artifact bytes/grade handle,
and unavailable real usage with no auth/live acceptance. Bounded results are
persisted separately in `task-framing-evidence.json`, without replacing the
earlier trio evidence or recording raw prompts/private check declarations.

Real native authentication and a live credential/tool plus approved-service
egress boundary still require independent future proof. No caller boolean,
environment variable, synthetic fixture, or passing offline task unlocks them.

## Reproduce the existing fixed probe

From PowerShell, with Docker's Linux engine available:

```powershell
node --test C:\Repositories\ai\evals\tests\clients-opencode.test.mjs
$env:EVAL_CLIENT_OPENCODE_DOCKER='1'
node --test C:\Repositories\ai\evals\tests\clients-opencode.test.mjs
# Explicitly regenerate persisted evidence and actual parser fixtures:
node C:\Repositories\ai\evals\harness\clients\opencode\capture.mjs
```

The first invocation runs six unit tests and skips Docker. The opt-in invocation
runs all seven, including fresh default/two-artifact and single-artifact
build/container probes. No full suite is needed.
The capture command overwrites only this adapter's evidence/fixtures, never
shared schemas, manifests, other client adapters, global configuration, or
isolation code.

The API builds with the equivalent command below, replacing `<uuid>` with its
new lowercase UUID each time:

```powershell
docker build --pull=false --label ai.skill-eval.opencode-offline=<uuid> -t skill-eval-opencode:<uuid> C:\Repositories\ai\evals\harness\clients\opencode
```

It inspects the built image, then runs **the immutable actual image ID**, not the
mutable tag:

```powershell
docker run --rm --name skill-eval-opencode-<uuid> --label ai.skill-eval.opencode-offline=<uuid> --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 768m --cpus 1 --tmpfs /work:rw,nosuid,nodev,uid=1000,gid=1000,size=256m --env 'EVAL_OPENCODE_ARTIFACT_TARGETS=["answer.md","message.txt"]' sha256:<actual-image-id>
```

Cleanup inspects exact names and matching owner labels before removing a
remaining container or its image tag. It never prunes Docker, uses the Docker
socket inside a container, mounts host folders/home, or removes another client's
resources. Normal Docker build cache remains. A build-stage public npm download
is permitted; runtime networking is `none` with loopback only.

## Reusable API

Import `evals/harness/clients/opencode/index.mjs`:

```javascript
import {
  runOfflineProbe, buildConfig, buildArguments, parseEvents, validateProbe
} from './evals/harness/clients/opencode/index.mjs';

const config = buildConfig(); // No caller-supplied provider, secret, or model.
const artifactConfig = buildConfig({ artifactTargets: ['message.txt'] });
const args = buildArguments();
// ['run', '--pure', '--format', 'json', '--model',
//  'offline-fixture/synthetic', '--title', 'Owned offline fixture',
//  'Exercise the offline fixture tools.']
const result = runOfflineProbe({ timeoutMs: 180000 });
const pilotProbe = runOfflineProbe({ timeoutMs: 180000, artifactTargets: ['answer.md', 'message.txt'] });
const selected = runOfflineProbe({ timeoutMs: 180000, artifactTargets: ['message.txt'] });
```

`buildConfig()` remains read-only by default. Explicit `artifactTargets` accepts
only unique `answer.md`/`message.txt` basenames, never paths, globs, fixtures,
home/config files, or arbitrary names. The probe defaults to both pilot artifacts
and rejects an empty target list: a read-only success is not artifact-profile
acceptance. Selecting one target also probes denial of the other target.
The integration contract returns top-level `client`, exact `clientVersion`, and
`pilotWritesVerified:true` only after the requested native creations and
protected fixture/home/config write denials have all been observed and
validated. It throws otherwise. This flag is offline artifact-capability
evidence, not live acceptance or evaluated model quality.

`runOfflineProbe` is synchronous, uses only `docker`, caps build time at 300
seconds and runtime at the supplied 1–300 second limit, and throws on failure.
It requires observed Docker engine `29.7.2`, Node `22.22.1`, and client `1.14.28`.
It runs the genuine in-container probe and reparses/validates its returned
machine events before accepting them. Its returned object includes:

```javascript
{
  client: 'opencode',
  clientVersion: '1.14.28',
  transport: 'offline-mock/not-live',
  accepted: true, liveAccepted: false, modelQualityEvidence: false,
  image: 'sha256:<actual built image ID>',
  manifestDigest: 'sha256:<Docker observed descriptor digest>',
  baseImage: 'node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d',
  events: [/* actual successful CLI JSON events */],
  trigger: { attempted: true, loaded: true, failedCalls: 0 },
  usage: { inputTokens: 50, outputTokens: 5,
           source: 'synthetic-inference-fixture' },
  completion: { completed: true, text: 'OFFLINE_FIXTURE_COMPLETE' },
  positive: {/* parsed success */},
  negative: {/* attempted skill, loaded:false, failedCalls:1 */},
  artifactTargets: ['answer.md', 'message.txt'],
  artifactWritesVerified: true,
  pilotWritesVerified: true,
  artifacts: {
    positive: {
      'answer.md': { content: 'OFFLINE_ARTIFACT_answer.md\n', regularFile: true },
      'message.txt': { content: 'OFFLINE_ARTIFACT_message.txt\n', regularFile: true }
    },
    negative: {/* real created files despite failed skill load */}
  },
  denials: { verified: true, evidence: [/* eleven actual tool failures */],
             events: [/* actual attack events */],
             writeAbsent: true, protectedFiles: {/* six verified checks */},
             credentialDisclosed: false },
  network: { externalBlocked: true, errorCode: 'ENETUNREACH',
             interfaces: ['lo'] },
  requests: [/* available tool names and actual tool-result feedback only */],
  scenarios: {/* bounded stdout/stderr/exitCode from each fresh invocation */},
  versions: {/* observed client, Node, ripgrep */},
  freshWorkspacePerScenario: true, freshHomePerScenario: true,
  cleanup: { container: 'removed', image: 'removed' },
  liveBlockers: [/* explicit unmet live prerequisites */]
}
```

`image` is Docker's observed content ID; `manifestDigest` is its observed
descriptor digest, not a fabricated registry publication. They may be equal
for a local image. Built IDs change when adapter sources/build metadata change.
The checked-in capture records one actual build, not a universal future digest.

`parseEvents(stdout, {exitCode:0, timedOut:false, cancelled:false})` parses
bounded newline-delimited actual `opencode run --format json` output. It rejects
missing/malformed/unknown events, identity/step inconsistencies, incomplete
tools, error events, failed tools, missing completion, cancellation, timeout,
nonzero/null exit status, and nonterminal finish reasons. Missing token data
returns `usage: null`; malformed token data fails. Usage is summed across steps
and explicitly synthetic, not paid billing or model quality evidence.

`allowToolErrors:true` is **only** for inspecting known negative controls and
attacks. It does not turn those failed calls into loaded skills or acceptance.
`validateProbe({positive, negative, attacks, requests, writeAbsent, network,
artifactTargets, artifacts, protectedFiles})`
applies strict happy-path parsing, then independently requires the expected
negative-control failure, genuine successful native Write calls with observed
regular-file bytes in both scenarios, and all eleven actual
permission/unavailable-tool failures (twelve when one artifact is selected).
Missing artifacts, stdout-only answers, failed writes, missing denials,
auth errors masquerading as denials, disclosure, a forbidden write, or
unexpected tool/provider request surface throws even if the happy path succeeds.

## Configuration and pinned-runtime findings

The custom provider uses the built-in `@ai-sdk/anthropic` implementation with
`options.baseURL: "http://127.0.0.1:43128/v1"` and a synthetic canary API key.
An in-container HTTP server implements the direct Anthropic SSE response
protocol. It validates the synthetic authentication header and model, and
captures the real client's subsequent tool-result messages. It is not a proxy,
gateway, hosted service, alternative client-tool implementation, or LLM.

The pinned CLI's actual `run --help` advertises `--pure`, `--format json`,
`--model`, and `--title`; captured help is in `evidence.json`. The client loads
and validates the actual provider/config syntax during every successful probe.
Official reference pages used:

- <https://opencode.ai/docs/config/>
- <https://opencode.ai/docs/providers/>
- <https://opencode.ai/docs/permissions/>

These current pages are not treated as proof of old-version behavior.
The pinned binary and actual invocations establish compatibility.

Controls:

- Isolated, new `HOME` and XDG config/cache/data/state for every scenario.
- Recreated `/work/project` per scenario; no inherited repository/user content.
- `--pure`, empty `plugin`, `mcp`, and `instructions`; fresh roots have no
  instruction files, custom hooks, agent overrides, or managed config.
- `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`,
  `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_LSP_DOWNLOAD`,
  `OPENCODE_DISABLE_CLAUDE_CODE`, and `OPENCODE_DISABLE_EXTERNAL_SKILLS`.
- Only `offline-fixture/synthetic` enabled for main/small models.
- Global permission `"*":"deny"`; only target skill, the exact fixture read,
  and explicitly selected artifact creation paths allowed.
  `external_directory` denied. Shell/network tools are excluded; native
  modification tools are available only under exact scoped `edit` permission.

**Pinned native Write matching differs from Read.** The real binary asks for
`edit` permission using `path.relative(worktree, filePath)`. This owned non-Git
workspace has worktree `/`, so its exact allowed patterns are
`work/project/answer.md` and/or `work/project/message.txt`, not absolute
paths or bare filenames. Both earlier forms were actually denied before the
correct pinned-runtime pattern was established. There is no wildcard write
allowance or global permission bypass. These patterns are scoped to this
adapter's fixed `/work/project` workspace; they are not a general arbitrary
workspace configuration.

**Discovery is actually `.opencode/skills/offline-target/SKILL.md`** in
1.14.28. The probe does not rely on a stale singular-path recommendation.
An initial attempt with `OPENCODE_DISABLE_PROJECT_CONFIG=1` hid the workspace
skill; it was removed rather than claiming a successful trigger. A subsequent
real skill load failed because the client tried to download ripgrep. The build
now provisions the real pinned public CLI package
`@vscode/ripgrep-linux-x64@1.18.0`, with observed binary
`ripgrep 15.0.0 (rev 3a612f88b8)`, on PATH. No tool implementation is mocked.
Package lock/integrities are persisted, install scripts disabled, and only
public pinned CLI packages installed during the build.

## Persisted actual evidence and acceptance

`evidence.json` records actual image IDs, versions, help, network failure,
freshness, cleanup, and observed outcomes. `fixtures/{positive,negative,attacks}.jsonl`
are actual machine output. `fixtures/probe-input.json` contains only captured
tool-result feedback, observed native artifact contents/file type, and
containment observations; HTTP headers/auth config
are not persisted. Parser mutation tests are tests of rejection, not
manufactured accepted traces.

Recorded capture:

- Actual image ID: `sha256:cd97d754758c6f0641b0cb7c4ec2cc94fca703fae12d95e42e1742ba46c20029`
- Base: `node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d`
- Docker `29.7.2`; OpenCode `1.14.28`; Node `22.22.1`.
- Actual successful `skill` result contains `OFFLINE_SKILL_BODY`; real fixture
  `read` result contains `SCOPED_FIXTURE_CONTENT`.
- Separate no-skill invocation has a genuine `Skill ... not found` failed call,
  not an accepted load or a skipped/prose-only trigger.
- Positive and no-skill invocations each actually create `answer.md` and
  `message.txt` through the client's native `write` tool. The probe verifies
  completed tool events plus on-disk regular-file bytes before recreating the
  workspace; it does not write the answer for the client or substitute stdout.
- Actual `read /proc/self/environ` is permission-denied. This attacks the
  process containing inline provider auth and a synthetic environment canary.
- Actual reads of an **in-workspace** synthetic private credential file and
  out-of-scope sentinel are permission-denied by scoped read policy.
- Actual Bash and webfetch calls fail as unavailable. Native Writes outside
  selected targets are permission-denied, including attacker, home, config,
  fixture, private credential, and skill-source paths. Home/config writes are
  absent and fixture/credential/skill/sentinel bytes remain unchanged.
  No canary/sentinel content reaches tool results. These denials are genuine
  failed calls with feedback observed by the mock provider.
- A separate opt-in single-artifact probe creates only `message.txt` and
  verifies that native creation of unselected `answer.md` is permission-denied
  and absent.
- External TCP attempt returns `ENETUNREACH`, with only loopback interfaces.

This is observed offline tool-boundary evidence, not a claim that Docker alone
protects an environment key from tools or that live egress is verified.
Acceptance requires all of the above; successful happy-path completion alone
is insufficient.

**Still not done:** real-provider credentials, explicit paid-smoke consent,
exact model/skill baseline approval, a live direct-endpoint egress verifier,
and live credential/tool acceptance. Synthetic inference cannot satisfy these,
and this adapter never marks a production/model-quality evaluation approved.
