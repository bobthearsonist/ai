# Pinned Copilot CLI offline probe and parameterized tasks

This additive client slice runs the **actual GitHub Copilot CLI 1.0.92** against
a scripted OpenAI-compatible SSE fixture listening on `127.0.0.1` **inside its
own Docker container**. It is client discovery, native tool-loop, artifact and
containment evidence, **not live inference or model-quality evaluation**.
Probe outcomes use `transport: "offline-mock/not-live"`; the separate task API
uses `transport: "offline-mock", offlineEvidenceOnly: true`.
The model ID `offline-fixture-model` is synthetic and never an approved quality
model. No real API keys, GitHub authentication, personal credential stores,
host HOME, Docker socket, unrelated workspace or global client settings are used.

The existing isolation module's live guard is unchanged. This module also
rejects `requireLiveProfile()` unconditionally. Live acceptance still needs
verified direct-provider endpoint egress/credential containment, explicit paid
smoke consent, narrowly provisioned credentials and an exact approved baseline.

## Pins and actual observations

* Public dependency `@github/copilot@1.0.92`, including Linux x64 optional
  dependency, is integrity-pinned in this slice's `package-lock.json`.
* Base: `node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d`.
* Observed in-container Node: **22.22.1**; Docker Linux engine: **29.7.2**.
* Actual `copilot --version`: `GitHub Copilot CLI 1.0.92.`
* Actual `--help`, `help providers`, and `help permissions` are captured by the
  probe. They confirm JSONL `--output-format json`, BYOK with no GitHub login,
  and supported availability/tool/path controls. Unsupported guessed flags and
  unrestricted `--allow-all` are never substituted.
* The first npm launcher probe tried extracting its large packaged runtime into
  the small disposable cache and correctly failed with size/space errors.
  The Dockerfile now pre-extracts the pinned runtime at build time using a clean
  synthetic HOME. Runtime `XDG_CACHE_HOME` points to this read-only baked cache;
  writable `COPILOT_HOME` remains a fresh `/client-config/copilot`.
* Each build gets a unique image label/tag. Execution uses the **inspected
  content-addressed image ID**, never a mutable tag. Its exact digest is returned
  in `report.image` and retained in actual `fixtures.json` recordings.
* Final scoped-write acceptance image ID:
  `sha256:d6ced9c4cdf3272963ae335a675e26faa67a556e5f564b93192c84d5080b3e3b`.
  Unique invocation labels intentionally change the image ID between builds;
  the source/base/package integrity pins, not a deleted disposable image tag,
  are the reproducible inputs.

Only the build phase accesses the public npm registry. Runtime networking is
`none`, with loopback available for the fixture; no external provider requests
or hosted proxies are made.

## API and integration

Import `harness\clients\copilot\index.mjs` directly. No shared schema is added.

```js
import { runOfflineProbe } from './harness/clients/copilot/index.mjs';
const report = await runOfflineProbe({
  timeoutMs: 300000,
  artifactTargets: ['answer.md', 'message.txt']
});
```

The function builds an owned image, checks real version/help/provider syntax,
then runs six **independent fresh containers/workspaces**: read-only
candidate/control/attacks and scoped-write candidate/control/attacks. It throws
on missing or failed required evidence; error-shaped traces do not silently pass.
`artifactTargets: []` keeps the read-only profile and returns
`pilotWritesVerified: false`; it cannot satisfy pilot artifact requirements.
Explicit subsets of the two filenames are accepted; arbitrary paths, duplicates,
traversal and other filenames fail before Docker.

Representative result:

```js
{
  client: 'copilot', clientVersion: '1.0.92',
  transport: 'offline-mock/not-live',
  image: 'sha256:<actual-inspected-image-id>',
  accepted: true, pilotWritesVerified: true,
  artifactTargets: ['answer.md', 'message.txt'],
  liveAccepted: false, qualityEvaluated: false,
  freshWorkspaces: 6, network: 'none',
  positive: { events: [/* actual CLI JSONL */],
    trigger: { discovered: true, loaded: true, toolCallId: 'fixture_call_0' },
    fixtureRead: { succeeded: true, toolCallId: 'fixture_call_1' },
    completion: { status: 'completed', exitCode: 0,
      text: 'OFFLINE_FIXTURE_COMPLETE', errors: [] },
    usage: { tokens: {/* synthetic reported token counts */},
      usd: null, aiCredits: 0, premiumRequests: 0,
      source: 'actual-client-usage-file/synthetic-provider' } },
  control: {/* same normalized shape, discovered/loaded false */},
  denial: { accepted: true, evidence: [/* nine actual failed tool results */] },
  artifactProfile: {
    positive: {/* normalized actual create-tool session */},
    control: {/* fresh no-project-skill session, actual file creation */},
    artifacts: { accepted: true, evidence: [
      { path: 'answer.md', created: true, bytesVerified: true,
        toolCallId: 'fixture_call_2' },
      { path: 'message.txt', created: true, bytesVerified: true,
        toolCallId: 'fixture_call_3' }
    ] },
    denial: { accepted: true, evidence: [/* fourteen failed results */] }
  },
  cleanup: 'verified-owned-containers-and-image-tag-removed'
}
```

Additional exports:

| API | Purpose |
| --- | --- |
| `buildCopilotArguments({prompt?,artifactTargets?})` | Strict read-only/default or exact native artifact-write argument vector. |
| `parseCopilotEvents(stdout)` | Bounded strict JSONL parser, rejects malformed/unknown/partial/unmatched/duplicate events and missing terminal result. |
| `normalizeCopilotOutcome({stdout,exitCode,usage?,image?,expectedSkill?})` | Actual events, successful project Skill/load, Read evidence, errors, completion and separate usage units. Process/terminal exits must match. |
| `assessDenials(record,normalized)` | Mandatory actual denials, exact exposed tool set, no leaked synthetic canaries or unauthorized mutations. |
| `assessArtifacts(record,normalized)` | Both actual native `create` completion and exact on-disk bytes, not stdout. |
| `buildOfflineImage({timeoutMs?,signal?})` | Builds and returns an owned image handle; registry/network only at build time. |
| `runOfflineContainer(handle,{mode?,seconds?,signal?,artifactTargets?})` | Bounded diagnostic actual-client container; raw output is redacted, not normalized passing evidence. |
| `cleanupOfflineImage(handle)` | Label/digest-scoped removal of only that build's tag/image and owned Docker config directory. |
| `buildNativeImage`, `cleanupNativeImage` | Exact identity-preserving aliases of the case-free image build/cleanup functions; neither grants live/auth admission. |
| `describeNativeImage(originalHandle)` | Read-only description after the existing private image-handle identity check; rejects reconstructed IDs/tags/objects. |
| `requireLiveProfile()` | Always throws `LIVE_BOUNDARY_UNVERIFIED`. |

## Parameterized native task API

The additive `runOfflineTask` export executes **one caller-defined task** through
the same pinned Docker/native CLI boundary. It does not invoke `runOfflineProbe`,
substitute a raw-model implementation, fork the client, or evaluate AI with AI.
The existing probe API and its recorded artifact/denial evidence are unchanged.

```js
import { runOfflineTask } from './harness/clients/copilot/index.mjs';
import {
  gradeChecks, readCapturedArtifact
} from './harness/checks/index.mjs';

const checks = [
  { id: 'created', class: 'correctness', type: 'artifact-exists',
    target: 'reports\\caller.txt', expected: true },
  { id: 'content', class: 'correctness', type: 'artifact-contains',
    target: 'reports\\caller.txt', expected: 'caller output' }
];
const receipt = await runOfflineTask({
  task: {
    invocationId: 'local-example', caseId: 'caller-case', client: 'copilot',
    arm: 'candidate', repeat: 1, fixtureHash: '<64 hexadecimal characters>'
  },
  prompt: 'Use caller-skill, read fixtures/notes.txt, and create reports/caller.txt.',
  skill: {
    id: 'caller-skill',
    files: [
      { path: 'SKILL.md', content:
        '---\nname: caller-skill\ndescription: Caller-supplied task procedure.\n---\nRead the supplied notes.\n' },
      { path: 'references\\companion.txt', content: Buffer.from('Public companion\n') }
    ]
  },
  inputs: [
    { path: 'fixtures\\notes.txt', content: Buffer.from('Public input\n') },
    { path: 'layout\\README.md', content: 'Synthetic layout fixture\n' },
    { path: 'AI\\README.md', content: 'Explicit HOME layout data\n', mountRoot: 'home' }
  ],
  checks,
  mock: {
    loadSkill: true,
    artifacts: [{ path: 'reports\\caller.txt', content: 'Independent caller output\n' }]
  },
  timeoutMs: 180000
});

const bytes = readCapturedArtifact(receipt.capture, 'reports\\caller.txt');
const repeatedHostGrade = gradeChecks({ checks, capture: receipt.capture });
```

### Exact input contract

`async runOfflineTask({task,prompt,skill,inputs=[],checks,mock,timeoutMs=180000})`:

* `task` has exactly `invocationId`, `caseId`, `client: 'copilot'`,
  `arm: 'candidate'|'baseline'|'no-skill'`, `repeat: 1|2|3`, and a 64-hex
  `fixtureHash`. Invocation/case tokens are bounded to 100 literal characters.
  The receipt retains an immutable exact coordinate **copy**, not caller
  object identity. A fresh trusted `executionId` is generated independently.
* `prompt` is a nonempty caller string. It is passed as the actual native `-p`
  argument; its hash is checked against the native user event **and the first
  actual provider request**, after removing only the native datetime wrapper.
* `skill: {id,files}` accepts a lowercase hyphenated skill ID and explicit
  `{path,content,executable?}` files relative to the skill root. Every candidate
  and baseline requires a genuine root `SKILL.md` declaring that name,
  description and a nonempty body. Only `no-skill` accepts empty files; that
  arm must supply empty files and `mock.loadSkill: false`.
  Supported frontmatter is content/discovery metadata (`name`, `description`,
  `license`, `compatibility`, `metadata`, `argument-hint`, `user-invocable`,
  `disable-model-invocation`, `version`). Hooks, plugins, MCP, provider or
  permission directives/merges are explicitly
  `TASK_SKILL_CONTROL_PLANE_UNSUPPORTED`, not allowed to alter native policy.
* `inputs` accepts only the existing explicit
  `{path,content,executable?,mountRoot?}` agent-file schema. `content` is string
  or Buffer; `mountRoot` is `workspace` (default) or `home`. There is no
  directory import, automatic HOME discovery, symlink import, extra
  `visibility`/source metadata, credential retrieval or client config import.
  HOME fixtures must be nested below `AI\\` (for example `AI\\README.md`);
  only `/home/eval/AI` is added to native readable directories. Root-level
  HOME seeds and other HOME roots fail before launch with
  `TASK_HOME_NATIVE_AUDIT_UNSUPPORTED`, never silently remapped.
* `checks` uses the existing hard-check declarations. The **complete
  declarations and all `expected` values stay exclusively in trusted host
  memory**. Only relative artifact target strings are derived for Docker.
  Trace/manual declarations retain the shared grader's explicit unsupported
  `error` outcomes; no new trace/manual success adapter is invented.
* `mock: {loadSkill:boolean,artifacts:[{path,content:string}]}` is an explicit
  **SCRIPTED LOCAL INFERENCE fixture**, not a grader, model decision or model
  behavior evaluation. Its supplied artifacts independently determine canned
  native `create` requests. Nothing is generated from `checks.expected`,
  specimens, answer keys or private grading files. A missing expected artifact
  is not silently filled in. Mock writes must select distinct declared targets.
* Unknown fields, mode/auth/env overrides, invalid bytes, escaped or aliased
  paths, prefix/file collisions, seed/output collisions and caps fail **before
  Docker or native loading**. Literal Windows/POSIX relative separators
  normalize to the same contained path. Case aliases, device names, ADS,
  trailing dots/spaces and permission-glob syntax are rejected. This bounded
  adapter supports portable ASCII path components, not every native filename.
  Automatic client config/hook/plugin namespaces are forbidden at the
  workspace/HOME roots: `.claude`, `.copilot`, `.opencode`, `.github`, `.mcp.json`,
  root `opencode.json`/`opencode.jsonc`, etc. The same root protection applies
  inside the narrowly authorized `HOME\\AI` directory. Target skill content has its own
  controlled `.github/skills/<id>` placement; arbitrary config cannot be seeded
  there. Ordinary non-executable `AGENTS.md`, `AI/local.yaml` and docs JSON
  examples remain explicit readable fixture data. They do not activate hooks
  or plugins; native custom-instruction loading remains disabled. The actual
  test verifies root AGENTS and docs JSON text is absent from the initial wire
  context and reaches it only via the scheduled native `view`.
  Private grading/auth names remain forbidden. Callers must still select non-secret agent bytes;
  a filename filter cannot recognize every semantically private value.

### Execution and trusted receipt

The public payload is delivered over the trusted Docker bootstrap's stdin,
**not as container environment, host-directory mounts or a tool DSL**.
The native CLI's own stdin remains closed. Docker's internal stdin attachment
does not request interactive authentication. Native PATH is a fixed in-image
allowlist; no host PATH, HOME, credentials, skills, hooks or config are imported.
No login/status command, paid inference, external provider call or autotrust is
used. Public dependency image building may use the npm registry as before.

Each call gets a fresh container/workspace, isolated client config and actual
native session. Supplied fixture/skill files are read-only; their full byte
hashes and modes are checked before/after. Directories are read-only except
selected output parents. Native permissions grant writes **only to
`mock.artifacts` targets**, not every checked target or the whole workspace.
Read-only source files and exact native grants protect shared output parents.
Only actual Skill/Read and, when selected, native `create`/`edit` are exposed.
HOME fixtures retain explicit native write denials and read-only byte/mode
verification; the native additional directory is never the whole HOME or a
configuration/target-skill directory. Shell, URLs, MCPs, scratch access, custom
instructions and automatic updates remain disabled.

The shared scripted SSE protocol also makes fixed **intentional safety-denial
requests** inside this new task session: proc/synthetic private/scratch/symlink
reads, unavailable shell/URL calls, unselected workspace/HOME/config creation,
and protected config/seed/skill/caller-fixture edits. Nonempty public fixture
bytes supply the actual search text for source-write denial probes; a missing
search string is not classified as a permission denial. HOME/AI also receives
an explicit unselected native creation attempt. These are new parameterized-boundary
assertions, not an old probe rerun. Expected native denial results are separately
classified; every requested Skill/Read/create must succeed. Unexpected native
tool errors, retries/extra requests, partial traces, leaks or unauthorized
filesystem changes are infrastructure failures, never passing receipts.

An actual `session.skills_loaded` audit is retained in full, including built-in
skills, whenever present. With narrow `--add-dir /home/eval/AI`, pinned Copilot
1.0.92 can emit startup discovery before its JSONL sink is attached. In that
case only, the independently captured **first actual provider request's system
`<available_skills>` catalog** supplies a distinct discovery audit. It must
contain exactly one closed, unambiguous catalog, valid name/description/source
fields and the actual native Skill schema, bound to the received request and
system-message hashes. Unknown sources, duplicate names/catalogs, malformed
entities/tags and missing/partial audit evidence fail. A malformed existing
JSONL audit cannot be rescued by this fallback. XML metadata has no path or
enabled field; neither is fabricated, and absent JSONL events remain absent.

Advertisement/catalog metadata alone or a mock load boolean is insufficient:
successful target native Skill start/result, native project/found telemetry,
the immediately subsequent full Skill body wire context and actual supplied
SKILL.md read bytes are required for `trigger.loaded: true`. Negative/no-skill
receipts require complete discovery/tool auditing, not absence of a log line.
Incomplete audits fail explicitly with `TASK_AUDIT_INCOMPLETE`.
Positive task fixtures read all supplied text files through native `view`;
full contents must appear in actual provider-request tool results.

Artifacts are read independently from the actual container filesystem, paired
with successful native `create` events, hash/size checked, and returned through
the trusted helper's bounded record. Native assistant text/stdout claims do
not substitute for disk bytes. The host materializes only this verified
readback into its owned capture directory, calls the existing
`captureArtifacts` and `gradeChecks`, then removes that directory/image/container.
The original immutable in-process `capture` handle survives cleanup. Do not
JSON-round-trip or clone it: the shared WeakMap rejects reconstructed handles.
The receipt exposes hash-bound audit/request/tool metadata, not raw prompt,
request transcripts, headers, credentials or candidate-prose grading.

```js
{
  client: 'copilot', clientVersion: '1.0.92',
  executionId: '<fresh trusted UUID>',
  task: {/* immutable exact coordinate copy */},
  promptHash: '<SHA256 verified from actual native wire>',
  image: 'sha256:<actual inspected image ID>',
  status: 'completed', transport: 'offline-mock',
  offlineEvidenceOnly: true, authenticationVerified: false,
  liveAccepted: false, qualityEvaluated: false,
  trigger: {
    loaded: true, evidence: [/* actual discovery-audit/skill-load refs */],
    auditComplete: true, discovered: true,
    auditSource: 'native-session.skills_loaded', /* or actual-first-provider-request-system-available_skills */
    discoveryAudit: [/* full actual session.skills_loaded events; [] when absent */],
    wireDiscoveryAudit: {/* native catalog, parsed metadata and hash binding, or null */},
    nativeLoads: [/* actual paired event hashes */]
  },
  capture: {/* original captureArtifacts handle */},
  checks: [/* gradeChecks(...).checks: passed/failed/error, no expected values */],
  evidence: {
    native: {/* immutable trace/request/tool/read/disk/boundary hash evidence */},
    checks: {/* gradeChecks(...).evidence */ }
  },
  runtime: {
    clientVersion: '1.0.92', image: 'sha256:<observed>', baseImage: '<base digest>',
    nodeVersion: '22.22.1', engineVersion: '29.7.2', network: 'none',
    auth: 'none-offline', nativeSessionFresh: true,
    nativeInteractionId: '<observed native ID>', model: 'offline-fixture-model',
    nativeElapsedMs: /* measured native CLI wall time */
  },
  usage: {
    inputTokens: { value: null, provenance: 'unavailable' },
    outputTokens: { value: null, provenance: 'unavailable' },
    elapsedMs: {
      value: /* measured including build/readback/grade/owned cleanup */,
      provenance: 'supervised-native-task-wall-clock including build, capture, grading and owned cleanup'
    },
    usd: { value: null, provenance: 'unavailable' },
    credits: { value: null, provenance: 'unavailable' }
  },
  cleanup: 'verified-owned-container-image-and-host-capture-removed'
}
```

`status: 'completed'` describes native infrastructure completion, **not a passed
grade**. Deterministic check failures remain factual outcome rows. A failed or
incomplete native run throws an infrastructure-class error rather than returning
an error-shaped success. Synthetic provider token/credit fields are not reused
as consumption evidence; unknown token/USD/credit values stay `null`.

### Task caps, cleanup and remaining limits

* Prompt: 16 KiB. Combined skill/input files: 24, 8 KiB each, 64 KiB total.
* Checked artifact targets: 8. Scripted artifact content: 8 KiB each, 32 KiB total.
  Check declarations: 64, 256 KiB serialized; kept on the host.
* Public bootstrap payload: 256 KiB. Provider request: 512 KiB, 64 requests
  maximum; the full planned tool sequence plus terminal request is bounded
  before launch. Native stdout/stderr combined: 384 KiB. Docker command output:
  the existing 1 MiB bound. Oversize/truncated native read/output is an explicit
  failure, never partial passing evidence.
* `timeoutMs`: 1,000–300,000, default 180,000, covering build and native
  execution/readback. Verified, separately bounded owned cleanup still runs
  on failure/timeout. No helper retry or global pruning occurs.
* All text, including Buffers, must be valid UTF-8 without NUL; opaque binary
  inputs are explicitly `TASK_BINARY_UNSUPPORTED`. Executable metadata does
  not enable code execution on noexec mounts or add shell tools.
* Nested output paths are supported by explicit parent preparation, exact
  native path grants and host contained capture; file/prefix collisions are
  rejected before launch.
* **Pinned HOME scope:** only explicit nested `HOME\\AI` fixture files are
  admitted. The narrow directory's actual native system catalog and complete
  tool/start/result/wire audit are checked independently. All protected
  read/write denials, nonempty HOME fixture edits and unselected HOME/AI
  creation must still be denied by the native client. Removing `--add-dir`
  restores JSONL discovery but denies these HOME reads; adding the whole
  HOME is not an accepted alternative. Other HOME roots remain explicitly
  unsupported. No client fork, inferred event, automatic remap or auth unlock
  is substituted.
* The same inspected pinned image, local daemon, non-root/no-capabilities,
  read-only-rootfs, no-bind-mount, `network: none` runtime limits apply.
  Cleanup checks only authentic invocation labels/image IDs and its owned
  directory. Abrupt host termination still needs scoped manual recovery.
* This is **offline transport/native-tool evidence only**, not behavioral model
  evaluation, baseline approval, authenticated native acceptance or a v2 live
  gate. Live/native-auth admission is separate future proof; a boolean,
  environment override or successful host alias help cannot unlock it.
  Conversely, a host alias help failure is not a blocker for the working pinned
  in-container native executable.

New task-only validation (does **not** rerun the old Docker probe):

```powershell
$env:EVAL_CLIENT_COPILOT_TASKS_DOCKER = '0'
$env:EVAL_CLIENT_COPILOT_DOCKER = '0'
node --test tests\clients-copilot-tasks.test.mjs
$env:EVAL_CLIENT_COPILOT_TASKS_DOCKER = '1'
node --test tests\clients-copilot-tasks.test.mjs
```

The opt-in new acceptance uses unique prompts, a non-demo caller skill plus
companion bytes, multiple workspace fixtures, arbitrary nested/top-level
caller output bytes, narrow readonly HOME/AI bytes, a private intentionally
mismatching host check, a fresh
negative-with-skill session and a fresh no-skill control. It proves the native
read/write/trigger boundary and host-side deterministic capture, not model quality.

Recorded new acceptance: **16 passed, zero failures/skips**, in 210.315 seconds.
Candidate/negative/no-skill had **7/5/5 full native reads**, **two disk-created
artifacts each**, and **15/15/14 mandatory denials**. All three used the complete
actual system-catalog discovery audit; only the candidate actually loaded the
target Skill. The deliberately mismatching private check failed in all three
despite identical independently scripted output bytes. Original host captures
were re-read/graded after verified owned cleanup. The candidate's inspected
image was
`sha256:6762ff61ed1da5fb59ced30a4e5d2cada02d3eae38d8a2047826fb50a3ca7056`.
Bounded factual run IDs, wire prompt hashes, counts and cleanup are in
`harness\clients\copilot\task-acceptance.json`; it is not a serializable capture
handle or a live-acceptance fixture. Combined new/preserved-probe unit
regression: **28 passed, three intentional Docker skips**. No old actual probe
was rerun.

## Mock-free native broker planning and observations

These additive exports prepare **native account-mode execution**, without
building an image, retrieving credentials, logging in, invoking a model or
admitting a live run. The settled offline API, public scripted inference and
offline guards are unchanged.

```js
prepareNativeTaskSpecification(
  { task, prompt, skill, inputs = [], artifactTargets = [] },
  { model, limits = {}, authRoot, proxyURL, toolTransport /* optional; planning-only below */ }
)

parseNativeTaskEvidence({
  specification, stdout, exitCode,
  usage, elapsedMs, submittedStdin, filesystemEvidence, image
})

readNativeTaskArtifact(originalObservation, target)
```

### Native specification

`task`, prompt and explicit skill/input files use the task contract above.
`artifactTargets` contains only relative declared output **names**, not output
content or checks. No `mock`, `checks`, private expectations, source-directory
imports, credentials, auth booleans or caller environment/config overrides are
accepted. Existing byte/path/collision/control-plane protection is reused.
Only nested `HOME\\AI` files are eligible for planning; that eligibility is
**not verified live HOME discovery**.

Broker-only options:

* `model`: a bounded literal native model ID, not a synthetic/offline/mock
  model. Binding this string in arguments does **not** approve the model or
  prove what a provider returned.
* `authRoot`: an isolated container configuration root below
  `/client-config/`, normally `/client-config/copilot`. It is a path reference,
  never credential material, a host import, an authenticated store or a lease.
* `proxyURL`: an explicit credential-free `http://<private-address-or-internal-Docker-name>:<port>`
  CONNECT proxy endpoint. Paths/query/userinfo/provider endpoints are rejected.
  It does not replace the native service origin or terminate provider TLS.
* `limits`: only `timeoutMs` (1,000–300,000; default 180,000) and
  `nativeOutputBytes` (1,024–393,216; default 393,216). These are supervision
  limits. Turn/token/account-spend fields are rejected, not silently applied.

### Optional original tool-worker transport: planning-only specification

The optional `toolTransport` value is exactly `{task,worker,lease,binding}`,
using the four original process-owned identities. The public synchronous
worker descriptor must match the five native task coordinates, ordered
`skills/<skill-id>/<relative-file>` / `inputs/<input-path>` byte/hash metadata,
`sourceHash`, and exact `artifacts/<target>` declarations. Copies,
serialization, cross-coordinate/source/target substitutions and stale
lifecycle states fail first. No caller command/env/path/manifest substitutes
for authority. See the [shared client-local validation contract and targeted
tests](clients-claude-code.md#optional-original-tool-worker-transport-safe-denial).

A valid tuple now yields a **planning-only** specification (the earlier blanket
`NATIVE_TOOL_TRANSPORT_UNSUPPORTED` denial was a not-yet-measured ambient
concern, not a proven API limitation). Pinned CLI 1.0.92 argv contains the
original `{command,args,env:{}}` under `--additional-mcp-config` server
`eval_tools`, `--disable-builtin-mcps`, `--no-custom-instructions`,
`--available-tools` of exactly `builtin:skill` (only when a Skill is selected)
plus `mcp:eval_tools-eval_read_public|eval_write_artifact|eval_read_artifact`,
matching `--allow-tool` entries, and `--deny-tool shell url read write`. The
sterile environment sets `COPILOT_PLUGIN_DIR_ONLY=true`, and the runtime
refuses a config root that already holds settings/MCP/LSP/provider/skills/
agents/hooks/extensions/plugins/IDE state, then writes the fixed read-only
`settings.json` `{disableAllHooks:true,ide:{autoConnect:false}}`. Local Skill
files remain native discovery seeds; inputs and artifacts are not staged or
captured client-locally, and the prompt gains generated worker-path guidance
(`nativePrompt`, separate from the unchanged `submittedPrompt`).

Still **unmeasured, not claimed**: that 1.0.92 excludes late/ambient MCP or
plugin tools by exact `--available-tools` matching, that
`COPILOT_PLUGIN_DIR_ONLY` and the settings keys suppress every ambient source,
managed-policy compatibility, MCP startup/discovery, and real Skill loading.
`nativeAdmissionSupported`, authentication, discovery, live and quality flags
stay false; the parser rejects such evidence with
`NATIVE_TOOL_TRANSPORT_OBSERVER_UNSUPPORTED`. Worker descriptions are
planning-only cached identity checks, never fresh kernel/native/auth/Skill/
catalog or admission evidence. Worker artifacts must be captured and mapped by
the HOST path. Inline Skill shell expansion fails with
`NATIVE_TOOL_TRANSPORT_SKILL_SHELL_UNSUPPORTED`. Targeted tests:
`tests/clients-copilot-sterile-tools.test.mjs` and the shared wiring test
(run with `--experimental-test-module-mocks`).
Without `toolTransport`, the original immutable specification contains:

```js
{
  kind: 'copilot-native-task-specification', planningOnly: true,
  client: 'copilot', clientVersion: '1.0.92', baseImage: '<pinned base>',
  executionId: '<fresh trusted UUID>', task: {/* immutable coordinate copy */},
  model: '<requested literal>',
  executable: '/opt/fixture/node_modules/.bin/copilot',
  entrypoint: ['node', '/opt/fixture/native-runtime.mjs'], cwd: '/workspace',
  argv: [/* JSONL/usage flags, explicit model, exact Read/Write/Skill policy */],
  env: {/* fixed native HOME/PATH/XDG; COPILOT_HOME; explicit proxy variables */},
  stdin: '<bounded canonical public bootstrap JSON>',
  stdinHash: '<SHA256>', stdinBytes: 123,
  stdinProvenance: 'submitted-bootstrap-stdin/not-provider-wire',
  submittedPrompt: {
    sha256: '<submitted prompt SHA256>', bytes: 123,
    provenance: 'specification-prompt/not-native-observation'
  },
  envelope: {/* public prompt/skill/inputs/output names plus broker references */},
  limits: { timeoutMs: 180000, nativeOutputBytes: 393216 },
  nativeHardLimits: {
    turns: null, totalTokens: null, accountSpend: null,
    provenance: 'unsupported-not-applied'
  },
  requirements: {
    brokerAuthenticatedCustody: true, brokerControlledCandidateAttachment: true,
    isolatedNativeOAuthStore: true, sanitizedControlPlane: true,
    nativeProxyCompatibilityVerified: false, linuxOAuthStoreVerified: false,
    completeNativeDiscoveryRequired: true,
    homeDiscoveryWithoutProviderWireVerified: false
  },
  authenticationVerified: false, liveAccepted: false, qualityEvaluated: false
}
```

The requirements are **requirements/unverified capabilities**, not measured
authentication or containment facts. The factory is pure and has no native
execution/admission path. Its original object identity is required by the
observer; reconstructing the specification from JSON is rejected.

The native argument vector preserves `skill`, `view` and selected `create`/
`edit`, exact output grants, source/config/HOME/proc/scratch denials,
`--no-custom-instructions`, `--no-auto-update`, `--no-ask-user`,
`--disable-builtin-mcps` and `--disallow-temp-dir`. Custom control-plane
hooks/plugins/MCP configuration remains forbidden. There is no all-allow,
autotrust, synthetic model or BYOK/API/token environment. The non-secret child
environment sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` only to the explicit
broker endpoint, likewise their lowercase equivalents, and sets both `NO_PROXY`
and `no_proxy` empty; **actual pinned-client proxy
compatibility remains unverified**.

### Candidate lifecycle boundary

Case-free `buildNativeImage`/`cleanupNativeImage` are the existing owned
build/inspection/cleanup functions, not a credential/container broker.
`describeNativeImage` validates the original private image handle and describes
its inspected image, base, pin and invocation label. It does not authenticate
an account or authorize attachment.

The future admitted broker must independently bind the original evaluation,
profile, source/image, authenticated custody and owned egress boundary **before**
creating/attaching a candidate. `runOfflineContainer` is not a live executor:
it still forces network `none` and an offline fixture entrypoint. No public
factory, proxy URL, filesystem path, JSON receipt, native stdout assertion or
caller boolean can substitute for those broker authorities.

The image includes the separately syntax-checked, **not live-executed**
`native-runtime.mjs`. Once an outer broker has legitimately admitted a
candidate, that helper validates bounded stdin again, materializes only explicit
read-only fixture/skill files, prepares selected output parents, and invokes
the unmodified native CLI in normal account mode. It has no inference server,
mock responses, fixture answers, credential selection, login/status operation
or auth lease. It returns:

```js
{
  source: 'copilot-native-task-bootstrap',
  client: 'copilot', clientVersion: '1.0.92', nodeVersion: '22.22.1',
  executionId: '<submitted execution ID>',
  submittedStdin: { sha256: '<actually read bootstrap stdin>', bytes: 123 },
  stdout: '<bounded actual native JSONL>', stderrHash: '<SHA256>',
  exitCode: 0, elapsedMs: 123, outputLimited: false, timedOut: false,
  usage: {/* actual native usage file or null */},
  filesystemEvidence: {
    before: [/* readonly seed manifests */], after: [/* actual manifests */],
    artifacts: [/* bounded disk readback, base64/bytes/SHA or missing/error */],
    unauthorizedFiles: [/* actual workspace/HOME audit */]
  },
  authenticationVerified: false, liveAccepted: false
}
```

The broker must reject timeout/truncation/runtime failure, validate this
record's provenance against its original candidate/image, and retain its
original receipt. The observer does not supply that authority.

### Conservative native observer

The observer parses the actual pinned JSONL vocabulary with paired native tool
events and a terminal result; malformed, unknown, partial/unpaired traces fail.
It does not require a fixed mock tool sequence, canned final answer, scripted
output bytes or provider-request transcript. Returned fields are:

* `completion`: native exit/status/session ID plus hashed native error events,
  **not model quality or grading**.
* `submittedStdin`: submitted specification hash/size, a separate
  `observed` flag when matching bootstrap readback metadata was supplied, and
  source provenance. Matching bytes do not prove authenticated attachment.
* `prompt`: `submittedHash`, independently recorded `nativeObservedHash`
  (`null` when absent), matching/recorded state, native event hash and
  `providerWireHash: null`. A submitted hash is never substituted for native
  prompt evidence.
* `model`: `{requested, observed, observedModels, provider, matches, dispatches,
  provenance, providerWireVerified:false}`. `observed` comes only from actual
  `model.call_start`/`model.call_final_result` fields; absent/blank metadata
  yields `null`, not the requested model or assistant prose. `provider` is
  only the native client-reported `isByok` classification; it is not login or
  account/custody proof.
* `catalog`: actual discovery skills when complete; executed tool names but
  no invented available-tool schema; hashed native configuration/disabled-tool
  metadata; MCP server/status snapshots when supplied. Full config/tool
  catalogs remain incomplete, and unobserved hooks/plugins are `null`, not
  falsely “disabled”.
* `trigger`: `{loaded,discovered,auditComplete,discoveryAudit,auditSource,
  nativeLoads,evidence,providerWireContextVerified:false,
  homeAuditLiveVerified:false}`. A load needs actual selected native Skill
  start/result, project/found telemetry, declared body length and genuine
  discovery. Assistant prose cannot establish it.
* `tools`: actual paired evidence, source-byte read observations, exact
  selected writes, observed denials/violations and native model-call count.
* `filesystem`: independently supplied disk-readback/mode/hash observations,
  actual artifact metadata and blockers; no stdout-only creation proxy.
* `usage`: exactly five `{value,provenance}` metrics. Token counts use native
  usage-file model counters; elapsed uses explicitly supplied broker time or
  native terminal duration. USD/credits remain unknown. Missing values remain
  `null`; genuine measured zeros are preserved.
* `nativeUsage`: cache counters, per-model request counts, native premium
  request fields and **unchanged `totalNanoAiu` in `nanoAIU` units**. It is
  neither USD nor an invented credit conversion. Synthetic offline recordings
  do not become real consumption evidence.
* `blockers`: concrete prompt/model/BYOK/discovery/filesystem/tool mismatches
  or unavailable audit. The observer always returns `observationOnly:true`,
  `authenticationVerified:false`, `liveAccepted:false` and no grades.

Verified artifact byte copies are accessible only using
`readNativeTaskArtifact(originalObservation,target)`. The original
in-process WeakMap handle survives cleanup; clones/JSON reconstructions are
rejected. An outer trusted host can materialize those byte copies and call
the existing `captureArtifacts`/`gradeChecks`, retaining the **original host
capture**. The observer never imports or sends private checks/expected values
to the candidate.

### Remaining native blockers and validation

The auth owner currently provides **empty evaluation-only staging**, not a
verified/attachable Linux OAuth store. Storage format, keychain/plaintext
compatibility, refresh, root-vs-tool protections and authenticated attachment
remain unverified. Its authenticated-custody admission remains closed.
Network policy and candidate attachment are independently owned; a CONNECT
plan is not a verified native provider transport or account. The legacy
Node-only candidate does not adopt the Copilot image. The separate
`prepareNativeEgressCandidate` route now retains the original client-owned
image handle and observes its actual version/help, executable, baked cache
layout and UID/GID `10001:10001`. The shared host runtime inspection requires
that exact client identity, not Claude/OpenCode's `1000:1000`.
These credential-free observations establish native attachment, not an
authenticated task, provider compatibility or credential/tool separation.
The measured Docker image ID is also not verification of the profile's
requested OCI manifest digest.

The complete HOME/AI discovery fallback used by offline tasks was captured
from provider HTTP system content. It is **not available as verified native
live evidence through encrypted pass-through**. Missing
`session.skills_loaded` returns `NATIVE_DISCOVERY_AUDIT_INCOMPLETE`; no XML,
assistant claim, mock flag, submitted envelope or absent log line fills the gap.
No native hard turn/token/account-spend cap is claimed.

Initial unit-only validation after the pure task API additions: **37 passed, three intentional
Docker skips** across new and preserved Copilot tests; bootstrap syntax checked.
That initial slice made no native image build, auth/login/status/account/model/
paid call, old probe or settled native matrix run. Later original-image
attachment and host integration remain version/help-only; neither uses those
unit results as authentication or live-task evidence.

## Native discovery and artifact boundaries

For the preserved fixed probe, the synthetic project Skill is
`.github/skills/offline-fixture-skill/SKILL.md`.
Discovery alone is insufficient. Required evidence is:

1. Actual `session.skills_loaded` with exact project path/source.
2. Actual `tool.execution_start` for `skill` with the requested Skill name.
3. Matching `tool.execution_complete` with `success: true` and native
   `result.content` saying the Skill loaded successfully.
4. The next actual provider request contains the Skill body marker.
5. Native `view` returns the synthetic fixture marker.

Built-in Skills remain discoverable but do not qualify as the project trigger;
no personal Skills are mounted. The control has no project Skill file.

Default `--available-tools skill view` removes every other tool. Scoped artifact
mode additionally exposes actual `create`/`edit` and grants only
`--allow-tool write(/workspace/answer.md) write(/workspace/message.txt)` for the
explicitly selected targets. No blanket write approval is used. Shell and URL
permissions are denied, MCPs/custom instructions/autoupdates/user prompts are
disabled, and automatic scratch-directory access is disabled.

Actual attack results:

* `view` of `/proc/self/environ`, synthetic private credential, out-of-scope HOME
  sentinel, scratch sentinel and workspace symlink to private credential:
  `success: false`, `error.code: "denied"`.
* Forced `bash` and `web_fetch`: `success: false`, native `"Tool '<name>' does
  not exist."`; provider schemas do not expose them.
* Read-only forced native `create`/`edit`: unavailable.
* Scoped artifact mode: unapproved workspace filename, protected fixture edit,
  HOME/config writes, protected config edit and an allowed artifact filename
  symlinked to private credentials all return native permission denial.
* Allowed `answer.md` and `message.txt` are **actually created by the CLI's native
  tool**, and trusted fixture code independently checks their exact bytes.
* Private/scope sentinels remain unchanged; no denied tool returned their values.
  Raw leak checking precedes host-side redaction.

Native permissions rely on pinned client behavior, not environment-key masking.
Synthetic credential injection by itself is not proof of credential safety.
These exact-path grants are not a universal arbitrary-file-write policy.

## Runtime confinement and cleanup

No bind mounts. Non-root UID/GID 10001, read-only rootfs, no capabilities,
no-new-privileges, no shared IPC, Docker log driver `none`, one CPU,
768 MiB RAM/no extra swap, 96 PIDs, 256 file descriptors, bounded file writes,
four bounded noexec/nosuid/nodev tmpfs areas. Actual Docker inspection checks the
boundary before starting the CLI. Output is capped at 1 MiB per Docker command;
client stdout/stderr are capped inside the fixture too.

Wall-time/cancellation terminate the attach process, force-remove only the
invocation-labeled container, then verify absence. Image cleanup checks the
same invocation label and digest before removing its tag. No global pruning,
daemon/firewall modification or remote mutation occurs. Abrupt host termination
can interrupt JS cleanup; invocation labels/names permit scoped manual recovery.
Docker assumes a trusted host/daemon/kernel; this is not a kernel-escape defense.

## Reproduction and validation

From `C:\Repositories\ai\evals`:

```powershell
node --test tests\clients-copilot.test.mjs
$env:EVAL_CLIENT_COPILOT_DOCKER = '1'
node --test tests\clients-copilot.test.mjs
node harness\clients\copilot\exercise.mjs accepted
```

The first command is offline unit-only and intentionally skips Docker tests.
The opt-in tests call the owned build API (Dockerfile + `npm ci`), verify actual
CLI discovery/control/Read/native artifact writes/denials, then separately
verify real local 401 errors, native missing-file tool errors, timeout and
cancellation with owned cleanup. `exercise.mjs accepted` saves an explicit
sanitized diagnostic report in this owned slice. `exercise.mjs record` regenerates
`fixtures.json` from actual CLI sessions; fixture event output is not fabricated.

Observed 2026-10-07: read-only and scoped-write attacks accepted, both native
artifact files created, both fresh controls have no project Skill load.
Targeted default suite: **13 passed, 2 deliberate Docker skips**. Final opt-in
suite: **15/15 passed, no skips** (238.2 seconds), including actual timeout and
cancellation. Final label-filtered inspection found no remaining Copilot probe
containers/images or owned configuration directories.
Actual auth failure emits `model.call_failure`, `session.error` with
`errorType: "authentication"`/HTTP 401, then terminal exit 1. A native tool
failure may still end at CLI exit 0; normalization rejects it as a passing
completion. USD is unavailable (`null`), not inferred from AI credits/premium
requests. Synthetic usage is never billing or quality evidence.
