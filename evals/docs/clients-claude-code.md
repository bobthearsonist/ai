# Actual Claude Code offline client execution

This additive module exercises **actual Claude Code 2.1.291**, not an imitation
of its tools or permission checks. Only inference is scripted. Every normalized
offline result has `transport: "offline-mock"`, `mockProvider: true`, `live: false`, and
`realQuality: false`. Passing proves this synthetic client discovery/tool-loop
case and its explicit denial probes; it does **not** establish live provider
acceptance, real model quality, an approved model, or an approved baseline.
The shared isolation module's live guard is unchanged.
The pilot-compatible default additionally verifies native creation of exactly
`answer.md` and `message.txt`, not stdout substituted for those artifacts.
`runOfflineTask` additionally executes parameterized caller prompts, exported
skill bytes, explicit agent fixtures, and bounded arbitrary artifact targets.
It uses the same pinned native client and offline service boundary. The original
probe, retained evidence and strict two-name probe helpers remain unchanged.
Separate mock-free **planning and observation** helpers are documented below.
They do not execute or authenticate a live task, adopt an egress slot, or admit
a requested image/model/profile.

## Commands

From PowerShell, using the repository's existing Node test runner:

```powershell
node C:\Repositories\ai\evals\harness\clients\claude-code\probe.mjs --capture
node --test C:\Repositories\ai\evals\tests\clients-claude-code.test.mjs
$env:EVAL_CLIENT_CLAUDE_DOCKER = '1'
node --test C:\Repositories\ai\evals\tests\clients-claude-code.test.mjs
Remove-Item Env:\EVAL_CLIENT_CLAUDE_DOCKER
```

Default tests are offline and read retained actual event fixtures. The opt-in
tests build/run the pinned CLI, execute candidate and fresh no-skill control,
and exercise runtime timeout and cancellation cleanup. `--capture` is optional:
it writes sanitized evidence only beneath the owned client module.

The probe performs the reproducible build itself:

```text
docker --config <fresh-owned-directory> --host <local-engine> build --quiet
  --label ai.skill-eval.claude-owner=<uuid>
  --tag skill-eval-claude-<uuid> <owned-client-directory>
```

The Dockerfile first copies the dependency manifest and integrity-locked public
npm packages, then uses `npm ci`. Its base is
`node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d`.
The wrapper and native platform package are both pinned to `2.1.291`.
Build output and each runtime verify `claude --version`; the runtime records
and validates exact `--help` flags. Node is verified as `22.22.1` and Docker
engine as `29.7.2`. Drift is a failure, not an implicit upgrade.

## Stable API

Import `harness/clients/claude-code/index.mjs`:

```js
const report = await runOfflineProbe({ timeoutMs: 120000, artifactTargets: ['answer.md', 'message.txt'] });
```

This parent-facing entrypoint internally checks actual positive, no-skill,
artifact creation and every denial, and **throws** with
`code: "OFFLINE_PROBE_NOT_ACCEPTED"` and a serializable `error.report` when those
checks fail. Timeout/cancellation/execution failures also throw. It cannot
silently return an error-shaped report to an unsuspecting integration.
Requested targets are propagated into the real client policy and tool script,
not ignored. `pilotWritesVerified:true` is returned at the top level only after
both arms really create every selected artifact and protected fixture/home/config
writes are denied. This entrypoint rejects an empty target list; read-only
diagnostics belong to the lower-level API and do not satisfy pilot eligibility.
The lower-level diagnostic API retains rejected traces when investigating:

```js
const report = await runClaudeOfflineProbe({
  timeoutMs: 120000,        // per arm, 1000..300000; shared CLI's 180s is supported
  buildTimeoutMs: 300000,   // 1000..600000
  signal: abortController.signal,
  capture: false,
  providerScenario: 'normal', // also 'provider-error' (HTTP400), 'stall'
  artifactTargets: ['answer.md', 'message.txt'] // exact selected names, not globs
});
```

Only these synthetic scenarios are supported. There is no real endpoint,
credential, arbitrary command, image, provider, or workspace override.
Windows uses the local Docker Desktop Linux pipe; Linux uses the local Unix
socket in the **host orchestrator only**, never in the client container.
The fresh Docker configuration contains no registry credentials or copied
personal configuration. Host command environment inheritance is limited to
executable discovery/Windows system paths.

The result includes:

```js
{
  client: 'claude-code', clientVersion: '2.1.291',
  transport: 'offline-mock', mockProvider: true, live: false, realQuality: false,
  accepted: true, // only offline scope; both arms and every denial must pass
  pilotWritesVerified: true, requestedArtifactTargets: ['answer.md', 'message.txt'],
  liveAccepted: false, qualityEvaluated: false,
  image: 'sha256:<actual-owned-image-digest>',
  imageSpec: { id, repoDigests, baseImage, os, architecture, nodeVersion, engineVersion },
  candidate: {
    client, clientVersion, image, transport, mockProvider, live, realQuality,
    events: [/* actual decoded client machine events, not fabricated results */],
    trigger: {
      skillId: 'offline-fixture-skill', requested: true, loaded: true,
      source: 'actual-client-tool-result', toolUseId: 'toolu_offline_0'
    },
    companionRead: true,
    artifactTargets: ['answer.md', 'message.txt'],
    artifacts: [{ path: '/workspace/answer.md', requested: true, created: true,
      source: 'actual-client-Write-tool-result', toolUseId, clientResult }],
    artifactWrites: [{path: '/workspace/answer.md', content: 'SYNTHETIC_OFFLINE_ARTIFACT_ANSWER\n'},
      {path: '/workspace/message.txt', content: 'fix: write synthetic offline artifact\n'}],
    artifactsPassed: true,
    completion: { status: 'success', parseError: null, exitCode: 0, result, terminal: true },
    usage: { status: 'unavailable', inputTokens: null, outputTokens: null, costUsd: null,
      reason, mockReported: {/* explicitly synthetic counters only */} },
    denialEvidence: [{ name: 'Read', input, toolUseId, denied: true, reason }],
    denialPassed: true, toolSurfacePassed: true, safetyPassed: true, accepted: true,
    canaryLeaked: false, fixtureChanged: false, forbiddenWriteExists: false,
    workspace: { cwd: '/workspace', home: '/home/node', fresh: true, containerId },
    boundary: { network: 'none', readOnly: true, user: '1000:1000', mounts: [], memory,
      pids: 64, capDrop: ['ALL'], securityOpt, tmpfs },
    raw: {/* sanitized actual stdout/stderr/help/wire capture */}, wire, liveBlockers
  },
  control: { /* same shape; requested:true, loaded:false, Unknown skill result */ },
  cleanup: { scoped: true, containersRemoved: true, imageTagRemoved: true, hostConfigRemoved: true },
  liveBlockers: [/* native authentication, bounded consumption approval, live containment and baseline acceptance are not established */]
}
```

`parseClaudeEvents(jsonl, {exitCode, timedOut, cancelled, outputLimited})` returns
the common fields, actual events, trigger, companion, usage, completion and
denial evidence without running Docker. Recognized completion states are
`success`, `error`, `timeout`, `cancelled`, `output-limit`, `partial`, and
`malformed`. It strictly checks pinned init, session identity, content shape,
tool-call/result identity, terminal ordering, and observed system event types.
Unknown event shapes fail closed instead of claiming acceptance.

`assessOfflineProbe(raw)` validates the captured envelope and combines parser,
tool registry/wire, arm-specific control, and raw-canary/write checks.
`buildRuntimeArguments(actualHelp, {artifactTargets})` and
`offlineSettings({artifactTargets})` expose the tested CLI flags/config.
These builders default to **read-only** (`artifactTargets: []`). The probe
default selects both pilot artifacts; selecting either alone is supported.
Targets must be unique and exactly `answer.md` and/or `message.txt`;
absolute paths, traversal, arbitrary names and globs are rejected.
`buildOfflineDockerArguments({owner,name,image,arm,providerScenario,
artifactTargets})` accepts UUID-scoped names and actual `sha256:` image IDs
only, and returns immutable-policy argument values: no mounts, environment,
network, privilege, or arbitrary command escape hatch.

## Parameterized native task API

The client index also exports `runOfflineTask`, `OfflineTaskError`, and
`TASK_CAPS`. Validation and byte snapshots happen synchronously; a valid call
returns a Promise for exactly **one fresh native session**, with no adapter
retry or automatic control run:

```js
const receipt = await runOfflineTask({
  task: {
    invocationId: 'caller-invocation', caseId: 'caller-receipt',
    client: 'claude-code', arm: 'candidate', repeat: 1,
    fixtureHash: 'a'.repeat(64)
  },
  prompt: 'Use record-receipt to write context/out/receipt.txt from my record.',
  skill: {
    id: 'record-receipt',
    files: [
      { path: 'SKILL.md', content:
        '---\nname: record-receipt\ndescription: Produce a record receipt\n---\nUse the supplied record.\n' },
      { path: 'references\\format.txt', content: Buffer.from('A public reference format\n') }
    ]
  },
  inputs: [
    { path: 'context\\record.txt', content: 'Public caller record\n' },
    { path: 'projects\\layout.txt', content: 'Synthetic HOME layout\n', mountRoot: 'home' }
  ],
  checks: [
    { id: 'receipt-exists', class: 'correctness', type: 'artifact-exists',
      target: 'context/out/receipt.txt', expected: true },
    { id: 'private-not-leaked', class: 'safety', type: 'artifact-not-contains',
      target: 'context/out/receipt.txt', expected: 'HOST_ONLY_ANSWER_KEY' }
  ],
  mock: {
    loadSkill: true,
    artifacts: [{ path: 'context/out/receipt.txt', content: 'An independently canned receipt\n' }]
  },
  timeoutMs: 180000
});
```

`task` accepts only the six shown coordinates. Invocation/case identifiers are
portable identifiers, at most 100 characters; `fixtureHash` is exactly 64 hex
characters. `arm` is `candidate`, `baseline`, or `no-skill`; `repeat` is 1, 2, or
3. The frozen receipt task is an exact structural copy, not an implicit baseline
approval or a recomputed fixture hash.

`skill` accepts only `{id, files}`. Files are explicit
`{path, content: string|Buffer, executable?: boolean}` entries relative to the
skill root. Candidate and baseline require a genuine root `SKILL.md` with its
exact name, nonempty description and body. No-skill **must** use an empty file
list and installs no skill. IDs are lowercase portable skill names, at most 64
characters, and cannot collide with observed native builtin skills/commands.
Skill-scoped `allowed-tools`, hooks, `context`, or `agent` metadata is explicitly
unsupported: it must not expand approvals or fork another agent.

`inputs` defaults to `[]` and uses the existing explicit-byte schema
`{path, content: string|Buffer, executable?: boolean,
mountRoot?: 'workspace'|'home'}`. Only caller-selected **agent-visible** exported
fixtures belong here. There is no directory/root/source-path importer, visibility
override, environment/configuration override, endpoint, image, auth or live
boolean. Private/judge/grader paths, credential filenames, client stores and
root instruction files are rejected. Automatic workspace/HOME control-plane
seeds such as root `opencode.json`/`opencode.jsonc`, `.mcp.json`, `.claude`
settings/hooks/plugins, `.opencode/plugins`, `.copilot` config and `.vscode`
MCP config are rejected **before launch**, not treated as safe merely because
their mounts would be read-only. Ordinary explicit non-executing data such as
`docs/opencode.json`, `docs/AGENTS.md` and `AI/local.yaml` remains readable.
Root `AGENTS.md`/`CLAUDE.md` is not accepted as inert data because native
automatic instruction suppression has not been verified for this profile.
Caller Buffers are copied before launch.
This bounded profile supports lossless UTF-8 text files, not arbitrary binary
assets; complete native Read evidence is required for files the script reads.
An executable bit does not enable Bash, an executable DSL or script execution.

Artifact targets come **only from artifact-check target strings**. They may be
nested ordinary relative paths, including a sibling output below an input's
parent directory. Slash/backslash separators are normalized. Traversal,
absolute/UNC paths, devices, permission-pattern characters, case/directory
aliases, duplicate mocks, source/output collisions, file/parent collisions and
reserved boundary/config targets fail before launch. Multiple checks may refer
to the same exact target. A declared target may be deliberately omitted from
`mock.artifacts`; capture then records it as missing. An unselected mock output
is rejected rather than silently granted.

`mock` is an explicit **SCRIPTED LOCAL INFERENCE fixture**, not a grader and
not evidence of actual model behavior. Its independently supplied artifact
strings become native provider `Write` calls. They are never synthesized from
`checks.expected`, private specimens or grading outcomes. The script optionally
requests the real `Skill` tool, reads supplied agent files and (when requested)
skill files through the real `Read` tool, writes only selected mock artifacts,
and exercises protected read/write denials.

### Host-only grading and native readback

Full check declarations and `expected` values stay in trusted **host memory**.
They are not copied into a container, image, mock input, environment, prompt or
command. The native payload contains public coordinates/prompt, source
manifests, artifact target strings and explicit mock bytes only.

Source bytes are staged exclusively from the supplied strings/Buffers beneath
the owned invocation directory **after** the pinned public image is built and
verified: a read-only skill-directory bind and read-only
per-file fixture binds contain **only those bytes**, never an imported host
directory or HOME. Writable noexec/nosuid tmpfs directory scaffolding supports
nested output parents; native file permissions allow only declared outputs.
Source mounts are verified read-only in actual Docker inspection, hashed before
and after execution, and each source is also subjected to a real denied Write.
Home/client settings, private canaries, proc, symlink escapes, shell/web tools,
unselected artifacts and project/skill settings retain actual denial checks.

After the CLI exits, the trusted in-container wrapper reads declared filesystem
files with regular-file, symlink, size and stability guards **before tmpfs is
destroyed**. The host requires a paired successful native `Write` creation
result and matching disk bytes. This envelope is readback transport, not agent
stdout substituted for an artifact. Host code materializes only verified
readback bytes, calls the existing `captureArtifacts` and `gradeChecks`, then
removes that directory with the rest of the owned invocation.

`receipt.capture` is the original shared-checks WeakMap handle. It survives
workspace cleanup **in this process**: `readCapturedArtifact` and `gradeChecks`
still work. A JSON-serialized/recreated handle does not. `receipt.checks` is
`gradeChecks(...).checks`, and `receipt.checkEvidence` is its evidence object.
Trace/manual checks remain explicit `error` outcomes because the shared checker
has no accepted adapter for them; no event grader or AI judge is invented.

### Receipt and failure semantics

```js
{
  client: 'claude-code', clientVersion: '2.1.291',
  executionId: '<fresh trusted launcher UUID>',
  task: {/* exact frozen coordinate copy */},
  image: 'sha256:<actual owned image ID>',
  imageSpec: { id, repoDigests, baseImage, nodeVersion, engineVersion, os, architecture },
  promptHash: '<hash of exact text observed in native provider-request capture>',
  status: 'completed', transport: 'offline-mock', offlineEvidenceOnly: true,
  authenticationVerified: false, liveAccepted: false,
  runtime: { clientVersion, actualVersion, image, nodeVersion, engineVersion,
    auth: 'none-offline', authenticationVerified: false, isolationEvidence },
  trigger: {
    loaded: true /* or false after a complete native audit */, evidence: [
      { kind: 'discovery-audit', skill, ref },
      /* actual paired successful native Skill results add skill-load records */
    ],
    skillId, requested, discovered, auditComplete: true, source, toolUseIds
  },
  artifacts: [/* immutable trusted target/state/hash/byte records */],
  capture, checks: [/* existing deterministic outcome records */], checkEvidence,
  rawCapture: {/* immutable synthetic first provider request, actual wire/results,
    decoded native events, source/disk evidence, denials and bounded stderr */},
  rawCaptureHash, completion,
  workspace: { fresh: true, cwd, home, nativeSessionId, containerId },
  boundary: {/* actual inspected offline limits and read-only source mounts */},
  safety: { denialPassed: true, sourceBytesUnchanged: true,
    sourceMountsReadOnly: true, rawCanaryObserved: false, toolSurfacePassed: true },
  cleanup: { scoped: true, containersRemoved: true, imageTagRemoved: true,
    hostConfigRemoved: true, sourceSeedsRemoved: true, artifactReadbackRemoved: true },
  elapsedMs,
  usage: {
    inputTokens: { value: null, provenance: 'unavailable' },
    outputTokens: { value: null, provenance: 'unavailable' },
    elapsedMs: { value: elapsedMs, provenance: 'trusted-host-monotonic-build-native-capture-cleanup' },
    usd: { value: null, provenance: 'unavailable' },
    credits: { value: null, provenance: 'unavailable' }
  },
  mock: { classification, requests, reportedUsage: {/* synthetic native counters only */} }
}
```

`usage` has exactly these five metric keys, each with only `value` and
`provenance`. Elapsed milliseconds are finite, nonnegative, measured by the
trusted host monotonic clock across build, native execution, capture and
cleanup; they are not model-only latency. Missing token/billing measurements
never default to zero. Synthetic native counters remain under `mock` only.
Measured runtime/image pins are offline evidence, not a claim that a
live/model profile was applied or admitted.

The prompt must actually occur in the first native provider request; its hash
does not come from receipt metadata alone. Native Read/tool-result bytes must
also occur in provider capture. Read's native line numbering/final-LF
presentation is distinguished from the exact supplied filesystem hash.
Pinned Claude 2.1.291 Read presents CRLF source lines as LF; this transformation
is audited and disclosed in each `sourceEvidence.presentation`, never applied
to supplied buffers, staged files, source export bytes or their SHA-256.
The audit requires exact structured content, complete start/count metadata,
exact one-based TAB-numbered native tool text and the full observed provider
frame (terminal empty-line TAB removal plus the native token reminder).
It accepts no arbitrary substring/wrapper or truncated line representation.
Unobserved/incompatible framing fails with `OFFLINE_TASK_SOURCE_UNSUPPORTED`.
Artifact Write and filesystem capture comparisons remain byte-for-byte exact.
Loading means observed successful native `Skill` results with discovery
evidence, never `mock.loadSkill`, candidate prose or a requested/denied call.
No-skill may request Skill and return actual `Unknown skill`; a negative script
may make no Skill call. Neither counts as loading.

`completed` means the native execution, wire sequence, complete audit, artifact
readback and protected boundary succeeded; deterministic checks can still
`failed` or `error`. Failed/incomplete native execution **throws**
`OfflineTaskError` with an infrastructure failure class and explicit code,
execution ID/phase/evidence where available. Incomplete audit records
`loaded:null, auditComplete:false` in error evidence rather than inventing
negative load proof. Original failures are preserved if cleanup also fails.
No adapter retry, authentication/login/status, live unlock, autotrust, global
configuration, host credential reads/copies, vendor/model call or account
consumption is performed. This receipt is **not a v2 live acceptance result**.

### Bounds and new native acceptance command

Caps are checked before launch where applicable:

| Surface | Cap |
| --- | --- |
| Prompt | 16 KiB, nonempty lossless UTF-8 |
| Skill + fixture files | 32 total; 16 KiB each; 128 KiB aggregate |
| Complete source text Read | 512 lines; 1,600 UTF-16 characters per line |
| Paths | 240 UTF-8 bytes; 8 relative segments |
| Declared artifact targets | 8 |
| Explicit mock artifact strings | 16 KiB each; 64 KiB aggregate |
| Host-only checks | 128; 256 KiB serialized |
| Public native payload | 208 KiB serialized |
| Directory scaffolding | 128 tmpfs directories including fixed roots |
| Native service | 96 requests; 2 MiB/request; 16 MiB total request traffic |
| Native event output / Docker envelope | 1 MiB / 4 MiB |
| Native container command | default 180,000 ms; 1,000..300,000 ms |
| Reproducible build / individual management commands | 300,000 ms / 15,000 ms |
| Runtime boundary | offline loopback; network none; nonroot; rootfs readonly; 768 MiB; CPU 1; 64 PIDs |

Build and owned cleanup have their own bounded phases; measured elapsed time
includes them. **Build is not task execution**: the empty owned Docker config
and whitelist-only `.dockerignore` permit the public pinned base image and
integrity-locked native npm install to use build networking/cache restoration.
No caller skill, prompt, fixture, private declaration, credential, or host HOME
is attached to that build; `.runs` and retained evidence are excluded. Only after
image verification are selected bytes staged and attached to a separate
`--network none` task container. No global dependencies are changed and no
provider/model/authentication calls are made. A missing public cache layer is a
build/restoration attempt, not automatic permanent native unsupported status.
Source file/skill export integrity and physical same-host
trustworthiness are not substitutes for a future authenticated live boundary.

```powershell
node --test C:\Repositories\ai\evals\tests\clients-claude-code-tasks.test.mjs
$env:EVAL_CLIENT_CLAUDE_TASK_DOCKER = '1'
node --test --test-name-pattern 'actual parameterized native task' C:\Repositories\ai\evals\tests\clients-claude-code-tasks.test.mjs
Remove-Item Env:\EVAL_CLIENT_CLAUDE_TASK_DOCKER
```

This separate opt-in case exercises an arbitrary unique multiline prompt,
non-demo skill ID and UTF-8 Buffer reference bytes, explicit workspace/HOME
inputs, two different nested caller artifacts, a selected-but-absent target,
fresh no-skill control, and a fresh negative no-load case with a deliberately
failing **host-only** private correctness key. It verifies native wire/file
evidence, separate session identities, all denials, capture survival after
cleanup and genuine unknown token/account metrics. Its bounded synthetic
summary is `harness/clients/claude-code/fixtures/parameterized-task.actual.json`;
existing probe captures are not overwritten or rerun by this command.

#### Recorded parameterized verification

The new opt-in command above exited **0** on 2026-10-08
(`verifiedAt: 2026-10-08T13:58:41.654Z`): one acceptance test, three independent
actual Claude **2.1.291** sessions, about **183 seconds** total. Runtime pins
were Node **22.22.1**, Docker **29.7.2**, Linux/amd64.

| New native case | Trusted execution ID | Actual load | Protected denials |
| --- | --- | --- | --- |
| Arbitrary prompt/skill/bytes | `f95edcab-e5fe-4f1d-8a5a-96abac26feba` | true | 20/20 |
| Fresh no-skill control | `ffc5445b-b1d6-4bca-bbf6-641aaf08dd99` | false, actual Unknown skill | 19/19 |
| Fresh negative no-load | `ab44ff7f-9d5f-4c89-a1aa-88612c7756f2` | false, complete no-call audit | 20/20 |

The positive actual owned image was
`sha256:b2c135d33572d58ec3ccd91f3e9c942ccfb8859352792d0cf002364a954ab6ee`.
The summary records each control's distinct actual image and native session.
The exact multiline caller prompt reached provider capture with hash
`0bb38d5e118b3a49a02d75e0a65a16cae55888e37fa132ffe470280390d4d383`.
The non-demo installed skill was `record-receipt-57230c01`, not the probe skill.
Four supplied skill/workspace/HOME files had complete native Read and wire
evidence. All three sessions genuinely created both
`context/out/caller-receipt.txt` and `delivery/deeper/card.md` (60/73 bytes),
including a nested output under an input's parent; the third selected target
stayed absent. The negative host-only correctness key failed as intended
without changing or leaking into the independent canned output bytes.

Every owned container/image tag/source seed/readback directory was removed;
the three exact invocation directories were separately checked absent.
Reading and regrading the original capture after cleanup succeeded; byte-copy
mutation did not affect retained bytes, and serialized-handle forgery was
rejected. No live/authentication acceptance was claimed.

Final default regression:

```powershell
node --test --test-reporter=spec C:\Repositories\ai\evals\tests\clients-claude-code-tasks.test.mjs C:\Repositories\ai\evals\tests\clients-claude-code.test.mjs
```

**27 passed, 6 opt-in tests skipped, 0 failures** (33 total). This includes new
prelaunch poison-config rejection in both fixture namespaces, ordinary
documentation-data acceptance, immutable byte snapshots, selected/no-skill
rules, private declaration exclusion, host/native readback hash binding,
exact V2 metric provenance and the public SDK candidate/baseline root payload.
Read units also bind the retained actual CRLF failure frames, cover
LF/CRLF/no-final-LF/mixed/lone-CR/final-empty-line presentation specimens, and
reject mismatched/truncated content, wrong line counts/IDs and arbitrary
native/provider wrappers. Edge specimens are deterministic unit data, not
claims of additional actual native sessions.
The actual config/hook/plugin poison files are never staged or launched.
The legacy native probes were not rerun.

#### LF-only SDK root-artifact reproduction

The separately selected LF-only SDK candidate payload passed on
2026-10-08 (`verifiedAt: 2026-10-08T15:10:22.620Z`), without any native
runtime/policy/evidence change or retry. Its prompt was
`Use example-skill to produce a plan using the supplied guide. Do not execute it.`;
the explicit Buffer workspace guide was
`Synthetic test-only guide: describe a safe offline plan without executing commands.\n`.
The genuine `example-skill` SKILL.md and reference were read and observed on
the provider wire. Native Write created root `plan.txt` with exactly the
30-byte independently supplied `Independent public mock output`, no final LF.
The original capture survived cleanup and passed host `plan-present` regrading;
all **19/19** protected read/write/tool denials passed.

Execution `2f7c48ed-677b-454a-a6ed-865bb8933142` used actual Claude **2.1.291**
and owned image
`sha256:2ab175e9b4256f525f1365e66af99cf3594d70990215bca78792203f8314d8ea`.
The exact prompt's wire-verified hash was
`6ca18a836324e3ec3f74c22523161d642e13e04ba5c460d6ad9fb0e1d06835aa`.
All owned resources were removed. This single new native test completed
in about **63 seconds**; it did not reproduce a caller's reported six-slot
SDK error, so it supplies no factual cause for those separate failures.
The caller later identified CRLF bytes in its copied workspace guide; this
earlier LF-only reproduction did not use those same bytes.
The bounded synthetic evidence is
`harness/clients/claude-code/fixtures/sdk-root-task.actual.json`.
If a future run throws, the test preserves the actual exception code,
message, evidence and cleanup result separately in
`sdk-root-task.failure.actual.json` before rethrowing; it never silently retries.

```powershell
$env:EVAL_CLIENT_CLAUDE_TASK_DOCKER = '1'
node --test --test-reporter=spec --test-name-pattern '^actual exact public SDK root artifact payload$' C:\Repositories\ai\evals\tests\clients-claude-code-tasks.test.mjs
Remove-Item Env:\EVAL_CLIENT_CLAUDE_TASK_DOCKER
```

#### Actual CRLF SDK failure and corrected acceptance

One narrow actual reproduction with the corrected **85-byte** workspace
Buffer ending `0D 0A` failed on 2026-10-08
(`observedAt: 2026-10-08T15:23:52.560Z`) with
`OFFLINE_TASK_SOURCE_UNSUPPORTED`. Native execution had completed, but the
host source audit incorrectly compared original CRLF directly with native
LF presentation. The actual exception and Read/provider frames are retained
in `harness/clients/claude-code/fixtures/sdk-crlf-task.failure.actual.json`;
execution was `a99b391f-5ee6-470d-942a-d1481b0352cb`, about **48 seconds**.

The real structured Read returned the **84-byte LF** content with
`startLine:1,numLines:2,totalLines:2`. Its native tool text ended `\n2\t`;
the real provider tool result ended `\n2` followed by the exact native
`\n\n<system-reminder>\n<total_tokens>14999998 tokens left</total_tokens>\n</system-reminder>`
frame. The token number is native synthetic fixture framing, not real usage.
The correction compares this complete pinned presentation exactly; it does
not normalize files, trim source data, search substrings or change artifact
capture/byte checks.

After targeted units passed, one bounded actual **CRLF** candidate acceptance
passed in **141 seconds**, without retry, LF-only or legacy-probe replay.
Execution `99984f94-0f7b-4985-9a3b-228fb8be76b3` used actual Claude **2.1.291**
and owned image
`sha256:604c88a881abc46d1d3980f704b3e714b26ff711d68ffcd0f129d8f9f7c8d420`.
Original source SHA-256
`174d64607f60d19c050c7717e1e7f2734d3511602171d80fb37d40e32fb67fc8`
remained unchanged on the read-only staged file; audited native LF content
SHA-256 was
`496c6bbd345ac44f2d0a827241c37748a4f9b3eca71230ef74f28660e9a59f73`.
All three source Reads and actual skill load were audited; **19/19** protected
denials passed. Genuine native Write created the exact **30-byte** root
`plan.txt`. The original immutable capture regraded `plan-present` as passed
after cleanup, and all scoped resources were removed. Prompt hash is unchanged
from the LF-only prompt above.

The complete bounded synthetic receipt summary, original source integrity,
presentation disclosure and real native/provider Read frames are retained in
`harness/clients/claude-code/fixtures/sdk-crlf-task.actual.json`.
Authentication and live acceptance remain false.

```powershell
$env:EVAL_CLIENT_CLAUDE_TASK_DOCKER = '1'
node --test --test-reporter=spec --test-name-pattern '^actual exact public SDK CRLF root artifact payload$' C:\Repositories\ai\evals\tests\clients-claude-code-tasks.test.mjs
Remove-Item Env:\EVAL_CLIENT_CLAUDE_TASK_DOCKER
```

## Mock-free native broker planning and observation

The same index adds these exports without changing the offline entrypoints:

```js
prepareNativeImage({ timeoutMs = 300000, signal } = {}) // sync validation, Promise<original handle>
describeNativeImage(originalHandle)                    // sync cached description/identity check
cleanupNativeImage(originalHandle)                     // Promise<scoped cleanup>
prepareNativeTaskSpecification(payload, options)        // pure sync original immutable specification
describeNativeTaskSpecification(originalSpecification) // sync original identity check
parseNativeTaskEvidence(observations)                   // pure sync deterministic observation
```

### Independent public-only image preparation

Image preparation needs **no case, prompt, fixtures, grading, mock, endpoint,
auth profile or credential**. It shares the previously inline public pinned
build with the offline task/probe. The Docker configuration is a fresh owned
empty directory; the `.dockerignore` remains a whitelist of public package
locks and existing runtime assets. New native helpers, `.runs`, source bytes
and retained captures do not enter that build context.
The Dockerfile explicitly asserts CLI `2.1.291 (Claude Code)` and Node
`v22.22.1` at build time. Docker `29.7.2`, Linux/amd64 and the ownership label
are checked after build. Preparation permits only `timeoutMs` (1,000..300,000)
and optional `AbortSignal`, not an arbitrary executable/image/Docker endpoint.
Build networking is for public pinned dependencies, never task execution.

The original frozen handle/description is:

```js
{
  preparationId, client: 'claude-code', clientVersion: '2.1.291',
  image: 'sha256:<observed owned image ID>',
  imageSpec: { id, repoDigests, baseImage, nodeVersion, engineVersion, os, architecture },
  caseIndependent: true, executable: '/opt/client/node_modules/.bin/claude',
  source: 'public-pinned-native-image-build',
  authenticationVerified: false, liveAccepted: false
}
```

Its identity lives in a private WeakMap. A reconstructed JSON object, another
manager's handle or a released/releasing handle cannot be described as active.
`describeNativeImage` checks original active identity, **not fresh Docker
existence, attachment or authentication**. Cleanup verifies the exact image
tag/ID/owner and host marker, removes only that tag/directory, then verifies
absence. It never prunes, forces image removal or cleans another owner.
Concurrent cleanup shares one Promise; subsequent cleanup returns its original
cleanup record `{preparationId,scoped,imageRemoved,hostConfigRemoved}`.
Build errors retain their primary phase/error evidence if cleanup also fails.

### Pure bounded native task specification

The builder accepts exactly:

```js
const specification = prepareNativeTaskSpecification({
  task: { invocationId, caseId, client: 'claude-code', arm, repeat, fixtureHash },
  prompt: 'Public explicitly selected caller prompt',
  skill: { id, files: [{ path: 'SKILL.md', content: /* genuine string/Buffer */ }] },
  inputs: [{ path: 'docs/guide.txt', content: /* explicit agent string/Buffer */,
    mountRoot: 'workspace', executable: false }], // default []
  artifactTargets: ['plan.txt'] // explicit public artifact target strings, may be []
}, {
  model: 'claude-sonnet-4-6', // bounded full claude-... native ID syntax; not admission
  limits: { timeoutMs: 180000, nativeOutputBytes: 1048576, maxTurns: 128, maxBudgetUsd: 0.5 }, // optional native guards
  authRoot: '/home/node/.claude', // ONLY an unbound container config/mount target
  proxyURL: 'http://172.19.0.2:8080' // credential-free local broker CONNECT proxy
});
```

Coordinate/skill/file/path rules and UTF-8, byte/line/count/collision/poison
guards match the offline task. No-skill requires empty skill files.
Private `checks`, `expected`, mock answers, env/endpoint overrides,
credential values, host auth paths and caller authentication booleans are
rejected. Only explicit public target strings enter native policy.
The proxy must be credential-free HTTP with an explicit port, root path and
no query/fragment, using RFC1918/loopback IPv4 or a simple Docker-local name;
this validates syntax, **not original boundary ownership or connectivity**.

The specification fields are `protocol,client,task,skillId,executable,
entrypoint,cwd,argv,stdin,model,environment,settings,policyHash,sourceFiles,
targets,mountRoles,tmpfs,imageRequirements,runtimeConstraints,limits,
authenticationVerified,liveAccepted,planningOnly,specificationHash`.
`stdin:{format:'text',text,bytes,sha256,provenance:'planned-input-only'}`
contains copied caller bytes, not a claim of delivery. `sourceFiles` contains
immutable lossless text and original byte hashes/read-only mount requirements;
CRLF bytes remain CRLF. The hash is of the planned public specification.

Execution requirements remain **unapplied** until an independent original
broker verifies them: direct native entrypoint
`/opt/client/node_modules/.bin/claude` (override image's offline `node
/opt/client/runtime.mjs` entrypoint), `/workspace`, UID/GID `1000:1000`,
readonly rootfs/source mounts, declared outputs, 768 MiB, CPU 1, 64 PIDs,
cap-drop ALL and no-new-privileges. The tmpfs/scaffold sizes are planning
requirements; this builder performs no mounting or filesystem setup.
`authRoot` is not a host path, mounted store, authenticated custody descriptor
or verified refresh permission. That mount role explicitly says `binding:
'unbound'` and `native-storage-and-refresh-unverified`; native tools deny
Read/Write of `.claude` and `.claude.json`.

Normal print mode retains `Skill,Read[,Write]`, exact Skill/Read/target-Edit
grants, default `dontAsk`, no permission prompts, disabled hooks/memory,
project setting sources, an explicit trusted settings file, strict empty MCP
and no session persistence. Bash/Edit/Web tools remain denied.
Neither `--bare` nor `--restricted` is added. No fake key, replacement
Anthropic base URL, provider answers or mock runtime is present. The clean
planned environment has HOME/TMPDIR/PATH/config target plus disable-update/
nonessential-traffic flags. Uppercase and lowercase HTTP/HTTPS/ALL proxy
variables use the same supplied local proxy; both NO_PROXY variables are empty.
No host HOME, PATH, plugins, hooks or credentials are imported.

The pinned normal catalog retains **both actual builtin plugins**,
`cc-plugin-agents-md` and `cc-plugin-plugin-authoring`, with their observed
`path:'builtin'` and builtin source identifiers. External plugins are not
permitted; a literally zero-builtin-plugin Skill profile remains unsupported.
Auth profile storage, OAuth/keychain refresh and proxy compatibility are
explicitly unverified, not enabled by this plan.

`limits` accepts only `timeoutMs` (1,000..300,000, host supervision required),
optional supervised `nativeOutputBytes`, optional safe-integer `maxTurns`
(1..128), and optional finite `maxBudgetUsd`
(>0..100), translated into the documented
print-mode `--max-budget-usd`. It is only a client list-price guard: prespend,
invoice, account quota or billing enforcement is **not** established.
The integrity-pinned 2.1.291 Linux binary registers the hidden `--max-turns`
option and has native `max_turns_reached` / `error_max_turns` terminal control
flow. Its omission from `--help` is not evidence of non-support.
The [exact published native package](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.291.tgz)
was verified against the repository lock SHA-512 integrity; its executable
SHA-256 is `078fad28d0297c9a25d306b635b2d8816c6839347520f29eb54ffea5d56142fb`.
`maxTurns` plans that main-agent tool-use counter for one text-input print task,
without automatic continuation or resume; `nativeTurnHardcap` is
`supported-scoped-not-applied` and `nativeTurnLimitApplied` remains false.
This is not a counter for all provider requests, retries, compaction or task
trees. The observer reports `completion.limit` from the native terminal subtype
and `num_turns`, rejects missing/invalid/excess counters when the limit was
requested, and keeps a reached limit an error, not a completed task.
Aggregate-token and hard account-charge caps remain unsupported/unverified;
`--task-budget`, per-request output settings and post-response cost estimates
are not substitutes. Unsupported limit names fail with
`NATIVE_LIMIT_UNSUPPORTED`. Output remains
bounded to 1 MiB and artifacts to 16 KiB/file. Image/custody/network/admission
are not performed by a specification.
`artifactTargets` is the pure-bridge input field; the earlier `targets` name
remains a compatible alias, but supplying both is rejected. The immutable
specification's normalized output field remains `targets`.
Optional `limits.nativeOutputBytes` is 1,024..1,048,576 (default 1 MiB), recorded
as `specification.limits.outputBytes` and enforced by the observer. It requires
broker stdout supervision, not an invented native token/output flag.

For original pure-bridge metadata/hash binding, use `specificationHash`,
`policyHash`, `task`, `model.requested`, `stdin.{sha256,bytes}`,
`limits.{timeoutMs,outputBytes}`, `targets`, `sourceFiles[].{target,bytes,sha256}`,
`imageRequirements` and `runtimeConstraints`. The intended config target is
`environment.CLAUDE_CONFIG_DIR` / the unbound auth mount role; the explicit
proxy is `environment.HTTPS_PROXY` (all proxy variants agree). These are
planned values only; no custody, candidate, mounted profile or runtime is
adopted. Keep the original specification for the parser/describer.

### Optional original tool-worker transport: planning only

All three pure native builders recognize one additional broker option,
`toolTransport: {task,worker,lease,binding}`. The four values must be the
**original process-owned objects**, not copied/serialized handles, commands,
environments, host paths or file manifests. A new wrapper containing the same
four originals is acceptable. Omission preserves the existing specifications,
prompts, allowlists, original-spec identities and observers.

The client-local validator calls the public synchronous
`describeToolWorkerTransportBinding` entry, without importing the parent
broker. It reconciles all five worker coordinates (invocation, case, client,
arm and repeat), ordered public path/byte/hash metadata, `sourceHash` and exact
artifact targets against the native payload. Public paths are
`skills/<skill-id>/<relative-file>` and `inputs/<input-path>`; target-only names
map to `artifacts/<target>`. It also checks the pinned worker/shim hashes and
the original frozen socket binding. Expired, closing, closed, cancelled,
cross-task and copied inner handles fail before any native configuration or
fallback can be returned. Caller Buffers are not rewritten and host checks,
private keys and correctness bytes are not accepted.

The reconciled internal description uses fixed server name **`eval_tools`**,
the original binding reference and exactly
`{command:binding.stdioCommand[0],args:binding.stdioCommand.slice(1),env:{}}`.
Its only tools are `eval_read_public({path})`,
`eval_write_artifact({path,contentBase64})` and `eval_read_artifact({path})`,
with the original closed schemas (`additionalProperties:false`).
The shim is neither reconstructed nor mounted; socket mounts/groups remain
worker/boundary-owned. This internal record is **not a returned native
specification** or transport authority reissuance.

**Claude Code 2.1.291 now plans a transport specification (planning only).** The
earlier blanket `NATIVE_TOOL_TRANSPORT_UNSUPPORTED` rested on the possibility of
policy-enabled plugins/hooks. That is a *not-yet-measured runtime* risk, not a
proven API limitation: official docs
([settings](https://code.claude.com/docs/en/settings),
[managed settings](https://code.claude.com/docs/en/managed-settings)) place
managed settings (file `/etc/claude-code/managed-settings.json`, server-managed
console policy, MDM) above every flag and `--settings` value, and no flag
removes them. In the sterile Linux image with no external plugin directories the
file source is image-controlled; server-managed policy depends on the account
and is unverifiable without running. It is therefore exposed as
`nativeToolPolicy.managedPolicyVerified:false` with admission blocker
`managed-policy-absence-unverified`, never assumed absent.

The plan keeps the pinned normal-mode argv (no `--bare`, no `--restricted`,
`--setting-sources project`, `--strict-mcp-config`) and changes only:
`--tools Skill` (empty string for no-skill), `--allowedTools` exactly
`Skill(<id>)` plus `mcp__eval_tools__eval_read_public`,
`mcp__eval_tools__eval_write_artifact` and `mcp__eval_tools__eval_read_artifact`,
`--disallowedTools Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch`, and
`--mcp-config {"mcpServers":{"eval_tools":{command,args,env:{}}}}` copied
exactly from the original binding. Generated settings keep `disableAllHooks`
and deny the native file/shell/web tools. Only skill files are staged read-only
for the real Skill catalog; inputs and artifacts are served and captured by the
worker (`targets:[]`, original `toolTransport` reference retained, plus a
`tool-worker-socket` mount role). The prompt bytes are unchanged, so the
`artifacts/<target>` mapping is not conveyed to the model. `timeoutMs`
defaults to and may not exceed the fixed 60000 ms worker lifetime.

Remaining blockers (all flags stay false): managed-policy absence, that
`--strict-mcp-config` also excludes plugin MCP servers, that Skill loads
without `Read`, actual native MCP consumption, worker-filesystem capture, and
the observer — `parseNativeTaskEvidence` rejects transport specifications with
`NATIVE_TOOL_TRANSPORT_OBSERVER_UNSUPPORTED`. Targeted unit:

```powershell
node --experimental-test-module-mocks --test --test-reporter=spec C:\Repositories\ai\evals\tests\clients-claude-code-sterile-tools.test.mjs
```

The [Copilot](clients-copilot.md#optional-original-tool-worker-transport-safe-denial)
and [OpenCode](clients-opencode.md#optional-original-tool-worker-transport-safe-denial)
pinned surfaces also fail explicitly. Synchronous identity descriptions remain
`planningOnly:true`, `verification:'cached-original-identity-only'`,
`freshKernelVerification:false`, `nativeAdmissionSupported:false`,
`evidenceScope:'worker-filesystem-only'`, and false auth/discovery/live flags.
The broker still needs fresh asynchronous original-tuple checks, genuine
native MCP/Skill/catalog evidence and worker-artifact capture. Worker artifact
metadata or absent client-local files are not successful native writes,
Skill loading, authentication, or an original HOST grading capture.
No prompt transformation occurs because these optional paths are denied.

Targeted transport units:

```powershell
node --experimental-test-module-mocks --test --test-reporter=spec C:\Repositories\ai\evals\tests\clients-native-tool-transport-identity.test.mjs C:\Repositories\ai\evals\tests\clients-native-tool-transport-wiring.test.mjs
```

The real-issuer test only prepares and closes owned workers; it never starts
Docker or issues a ready lease. Positive descriptor wiring uses an expressly
**wiring-only Docker-issuer mock**, the original identity-registry guard and
actual fixed worker/shim source hashes. Neither test establishes kernel,
native MCP, Skill, authentication, catalog or live acceptance.
Targeted unit regression passed **48/48**: nine new identity/wiring units and
39 selected existing native specification/observer units. No actual client,
Docker/offline matrix, authentication or provider experiment was rerun.

### Native JSONL observations, not live acceptance

Only an independently trusted broker supplies the process observations:

```js
const observed = parseNativeTaskEvidence({
  specification, executionId: /* fresh trusted launcher UUID */,
  jsonl: /* bounded original native stream-json stdout */,
  exit: { code, signal: null, timedOut: false, cancelled: false, outputLimited: false },
  submittedInput: { sha256, bytes }, // broker's actually delivered stdin record
  sourceState: [{ path: '/workspace/docs/guide.txt', bytes, sha256, unchanged: true }],
  capture: /* ORIGINAL host captureArtifacts handle, including missing targets */,
  elapsedMs: /* actual broker monotonic wall-clock measurement */,
  runtime: { image, nodeVersion: '22.22.1', argv, policyHash } // broker records only
});
```

The original specification and capture identities are mandatory when supplied.
Source state must contain exactly every original declared source/hash/byte
record. Host checks/expected values are not observer arguments and never
reach stdin, argv or env. Parent scheduling/grading retains the original
capture and performs `gradeChecks` on the host; this observer does not grade.

Its exact top-level fields are:
`protocol,client,clientVersion,executionId,task,specificationHash,status,
completion,issues,model,prompt,catalog,trigger,sourceAudit,artifacts,
artifactEvidence,capture,usage,costEstimate,runtime,nativeEnvelope,
denialEvidence,denialCoverage,authenticationVerified,containmentVerified,
liveAccepted,authority`.

* `model:{requested,selected,observed,provider,observedModels,perModel,
  source,selectionSource}`: `observed` requires a consistent nonblank full
  model from every actual `assistant.message.model`, not requested model,
  init selection, terminal prose or fabricated fixture output. Provider,
  canonical model, per-model cache/tokens/list-cost/cost basis are native
  `result.modelUsage` observations. Missing/conflicting model/provider
  metadata makes observations incomplete.
* `prompt:{submittedHash,submittedBytes,submittedSource,plannedHash,
  nativeObservedHash,nativeObservedSource,nativeEnvelopes,
  providerWireObserved:false}`: the delivered stdin record is distinct from
  native evidence. Native prompt hash is available only for an actual exact
  decoded plaintext user envelope; normal print need not echo it. Otherwise
  it stays null/unavailable, never copied from requested/submitted hashes.
  This is **not** full provider-wire/system-prompt proof or TLS interception.
* `catalog:{complete,source,scope,skills,tools,mcp,plugins,config}` audits
  native init's exact skill/tool/MCP/plugin catalog and both allowed builtins.
  Completeness is scoped to those reported fields. Config summary has
  `complete:false`: hooks/instructions are **not reported** by native init;
  requested policy hash is not a claim it was applied. Unexpected plugin/MCP
  records are represented only by hashes, never raw credentials/config.
* `trigger:{loaded,auditComplete,evidence}` uses native discovery plus a
  paired successful exact Skill result. Prose/requested/denied calls cannot
  establish loading. An incomplete catalog/envelope reports `loaded:null`.
* `sourceAudit` combines broker source-integrity records and complete pinned
  native Read results, preserving original hashes and explicitly disclosing
  CRLF-to-LF presentation. It never claims provider wire. Every successful
  Read must be declared and whole; `observedAllDeclaredSources` separately
  records whether native Read saw **every** declared file. Files not Read
  cannot be claimed as full model-context delivery.
* `artifactEvidence` requires the last paired successful native Write result
  and exact original HOST captured bytes. It records missing targets honestly
  and rejects out-of-scope writes. It currently requires exact canonical
  **absolute** tool `file_path`/native-result paths; relative/aliased/partial
  Read/Write framing is unsupported and explicit incomplete, not normalized
  into claimed evidence. The original capture survives workspace cleanup.
* `usage` has exactly `{inputTokens,outputTokens,elapsedMs,usd,credits}`,
  each `{value,provenance}`. Observed integer tokens have provenance
  `native-result.usage-not-provider-billing-verification`; elapsed is
  `trusted-broker-monotonic-wall-clock`. Missing values and USD/credits remain
  null/unavailable, never zero. `costEstimate` separately reports finite
  native list-price cost with `not-invoice` provenance, not paid usage.
* `nativeEnvelope:{sha256,records}` hashes the bounded native JSONL stream,
  not HTTP. Runtime image/node/argv/policy inputs remain broker records,
  not authentication or containment authority. Denials are only actually
  observed tool errors, not fabricated offline attack/control coverage.

Strict pinned event parsing rejects malformed/unknown/thinking/other unobserved
native envelope shapes, session drift, orphan results, retries and missing
terminal execution. Observations may be `completed`, `incomplete`, or existing
parser states `error,timeout,cancelled,output-limit,partial,malformed`; missing
observations have explicit `issues`. A completed observation is **not** a V2
receipt/admission: authentication, containment and live acceptance are always
false, with authority `deterministic-native-process-observation-only`.

### Unit-only implementation verification and blockers

Only the default owned Node command was executed for these additions:

```powershell
node --test --test-reporter=spec C:\Repositories\ai\evals\tests\clients-claude-code-tasks.test.mjs C:\Repositories\ai\evals\tests\clients-claude-code.test.mjs
```

**44 passed, 6 opt-in tests skipped, 0 failures** (50 total). Fake Docker
callbacks test image ownership/cleanup/cancellation only; constructed native
JSONL records are explicitly unit specimens, not new native/provider evidence.
The original 27 offline/task/probe passes and their exact CRLF/wire/artifact
semantics remain covered. No Docker build/native replay, auth/login/status,
provider/model/account call, package install, new agent, personal credential
read or shared broker/schema change occurred in this implementation phase.
Earlier actual offline captures above are historical, not new live evidence.

Original authenticated profile/refresh custody, native executable attachment
to an original enforced egress candidate, native consumption/account limits,
real billing and model/profile admission remain **blocked/unverified**.
The current network-only candidate's fixed Node image/UID10001 cannot adopt
this prepared native image/UID1000 through a DTO or image alias. An empty
`/home/node/.claude` locator is not auth-root custody/mount proof.
Image preparation/specification/observation do not bridge those blockers.

## Observed compatibility and event semantics

The official [permissions](https://code.claude.com/docs/en/permissions) and
[settings](https://code.claude.com/docs/en/settings) docs were fetched **before**
creating isolated config; no global/home config or permission YAML was changed.

Pinned runtime measurements matter more than help:

* The retained combined `--bare --restricted` attempt returned
  `No such tool available: Skill`; it does not prove bare-alone behavior.
  Pinned bare help explicitly excludes OAuth/keychain authentication, so it
  is not suitable for the normal native account path.
* `--restricted` leaves the `Skill` tool available but suppresses this project's
  skill discovery: actual `Unknown skill: offline-fixture-skill`, including
  when `--setting-sources project` is supplied.
* The working probe uses the **normal** CLI, a brand-new synthetic home,
  `--setting-sources project`, explicit settings, `--tools Skill,Read,Write`
  when artifact targets are selected (`Skill,Read` otherwise),
  `--permission-mode dontAsk`, `--permission-prompts none`, strict empty MCP
  config, no session persistence, and explicit prohibited-tool denies.
  It does not silently fall back from a failing safety policy at runtime.
* `--max-turns` is absent from this pinned help and is not used. Wall-clock,
  output, mock request count, memory, CPU and process caps bound the probe.
* `system/init.skills` contains the installed synthetic skill only for the
  candidate. Actual successful load is a paired `user/tool_result` with
  `tool_use_result: {success:true,commandName:"offline-fixture-skill"}` and
  `content: "Launching skill: offline-fixture-skill"`. Client-emitted skill body
  injection follows it. Neither agent prose nor a requested/denied call counts.
* The actual companion `Read` has `tool_use_result.file.filePath` and
  `file.content: "SYNTHETIC_COMPANION_7b924d"`.
* Actual artifact `Write` results contain
  `{type:"create",filePath:"/workspace/answer.md",content:...}` and
  `File created successfully at: /workspace/answer.md`. Both the paired
  successful native tool result **and** a matching on-disk file are required.
  Provider text, CLI stdout or a requested/denied Write is not an artifact.
* An actual HTTP400 client error ends with **`subtype:"success"` but
  `is_error:true`, `terminal_reason:"api_error"`, `api_error_status:400`,
  and process exit 1**. The parser treats it as error, not success.
* An observed HTTP401 path retries with `system/api_retry`; it was killed by
  the 90-second inner limit and has no terminal result. Its retained trace
  remains timeout/partial evidence, not an accepted run.

## Boundary and denial criteria

Each arm has a new container, home and workspace. No host home, unrelated repo,
Docker socket, ports, bind mounts, provider keys, or credentials enter runtime.
The mock Anthropic HTTP/SSE fixture binds only in-container loopback.
`--network none` prohibits external traffic even if a tool boundary failed.
The container is nonroot, rootfs read-only, capabilities dropped, privilege
escalation prohibited, memory 768 MiB, CPU 1, PID limit 64. Small noexec/nosuid
tmpfs directories hold synthetic inputs, private sentinel, config and CLI
scratch; writes inside them are not magically prevented by readonly-rootfs.
Actual unavailable/denied tool results are therefore required.

Thirteen attack probes must all produce real `is_error:true` denial/unavailable-tool
results: `/proc/self/environ`, private synthetic credential file, traversal,
workspace sentinel outside allowed fixtures, fixture symlink escape, Bash,
HTTP WebFetch, Write to fixtures, an unselected workspace artifact, home,
project settings and the immutable companion, and unavailable Edit.
Available client/API tool registries must be exactly `Read`, `Skill`, and
`Write` for the artifact profile (`Read`, `Skill` for read-only); sentinel
leakage, fixture modification, created
forbidden file, missing attacks/results or missing control all block acceptance.
The unredacted child output and provider tool-result traffic are checked for
the synthetic nonsecret auth canary (including base64/hex) **before** redaction.
Environment injection alone is never treated as a protection.

Native Write is scoped using the documented `Edit(//workspace/answer.md)` and
`Edit(//workspace/message.txt)` file permission rules (Write consults Edit path
rules), with default `dontAsk` rejecting any unapproved create. Explicit Edit
path denies protect fixtures, skills/project settings, home, private inputs
and probe config. No global Write allow, bypass-permissions mode, shell, git,
sync, service operation or elevation is enabled. Positive creation and all
forbidden-write checks execute in **both** fresh arms. Read/proc/private and
symlink protections remain active.

Absolute `Read` rules use the documented **double slash** `//` root anchor.
The retained `boundary-failure.actual.*` trace demonstrates that a single-slash
rule anchored to `/probe/settings.json` did not protect the workspace sentinel:
the actual CLI read it. That trace has `rawCanaryObserved:true` and is rejected
even though it loaded the skill and completed successfully. Corrected
double-slash rules deny the sentinel and symlink in both successful arms.
This is narrow evidence for these pinned synthetic fixtures, not a claim of
universal adversarial containment or safe live credentials.

## Evidence and cleanup

`fixtures/candidate.actual.*` and `fixtures/no-skill.actual.*` contain sanitized
actual JSON envelope/JSONL captures with exact observed image digest, complete
image spec, runtime/CLI versions, CLI help/arguments, boundary, distinct
container identities, and cleanup facts. Additional retained captures are the
rejected boundary failure, bare-disabled and restricted-undiscovered attempts,
HTTP400 errors, and HTTP401 retry timeouts.
JSONL files preserve actual machine events; provenance lives in adjacent
envelopes. Client-calculated list-price/usage fields in raw events are only mock
telemetry; normalized real usage is unavailable, **never zero**.

Image labels contain a fresh ownership UUID, so rebuilt owned image digests
can differ despite the same pinned dependency/base spec. The actual digest for
each measured run is recorded, not guessed from a tag. Container/image cleanup
uses exact recorded names/IDs after verifying ownership labels, bounded Docker
commands, and absence checks. No foreign containers/images are stopped or
pruned. Public package/build cache is not globally pruned. Host scratch is
removed only for that invocation. `capture:false` is the reusable default.

### Recorded verification

The final captured pilot-write probe completed with actual CLI
`2.1.291 (Claude Code)`, Node `22.22.1`, Docker `29.7.2`, Linux/amd64, image
`sha256:69b30c9aab4566d5dd1a84a7aedae9785c51d46ec6be40007c7ecb7c9e56be35`.
Candidate successfully loaded the skill and read the companion; the fresh
control returned actual `Unknown skill`. Both arms natively created both
selected artifacts, denied all thirteen attacks, and leaked no canary.
Exact owned containers/image and host configuration were removed.

Final default tests: **12 passed, 3 opt-in tests skipped**. The final parent-facing
pilot-write integration test also passed:

```powershell
$env:EVAL_CLIENT_CLAUDE_DOCKER = '1'
node --test --test-name-pattern 'actual Docker CLI' C:\Repositories\ai\evals\tests\clients-claude-code.test.mjs
```

The preceding read-only opt-in suite passed all fourteen then-current tests,
including actual runtime timeout and cancellation cleanup. Those lifecycle
checks remain available in the opt-in suite; pilot eligibility additionally
requires the later native-Write evidence, not the earlier read-only acceptance.

The shared CLI's 180-second option was subsequently verified end-to-end:

```powershell
node C:\Repositories\ai\evals\harness\cli.mjs probe-clients --clients claude-code --timeout-seconds 180
```

It exited **0**, invocation `88b47f57-1abf-4fb6-ba16-8da0f5d6a505`, reporting
Claude client version `2.1.291`, `transport:"offline-mock"`,
`liveAccepted:false` and `qualityEvaluated:false`. The owned adapter accepts
per-arm timeout values up to 300,000 ms, including the common 180,000 ms
integration option; the inner client, output and resource caps remain intact.
Owned regression tests verify 180,000 and 300,000 ms pass option validation,
while 300,001 ms fails before Docker. Default narrow tests again passed
12 tests, with the 3 opt-in tests skipped.
