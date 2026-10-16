# Disposable isolation primitives

Import `harness\isolation\index.mjs` directly. This new slice is intentionally
not wired into the contract CLI or either runner. It does not install clients,
authenticate, evaluate results with a model, select a runner, or claim a passing
live gate. The root evaluation README describes the deterministic contract.

## Supported and blocked execution

**Working:** bounded, offline Docker Desktop Linux execution of synthetic input
bytes, with no provider credentials and no network. `node` in the cached digest
below is **22.22.1**, not the host's Node 22.15.1. The executor checks observed
Docker engine **29.7.2**, Linux/amd64, cached image digest/ID, and the actual
in-container `--version` before executing each task.

**Blocked:** every `mode: 'live'` request, before environment processing, Docker
execution, or authentication. No supported direct-provider endpoint-restricted
egress implementation has been verified. A Docker network name, endpoint list,
environment variable, or caller-provided assertion cannot unlock live mode.
Normal client login/provider authentication is permitted in principle; a new
provider API key is not a stack requirement. Gateways/proxies are not substituted.
This module does not change host/daemon/firewall configuration.

Docker is a containment boundary, not a defense against a malicious/broken
daemon, kernel escape, or concurrent host administrator. Do not provide
production/customer data. A digest-pinned image must itself be trusted; an image
containing baked-in secrets or external clients/config would not become clean
because the mounts are clean. The synthetic verification uses the stock pinned
Node image and does not purport to accept a future client image.

## API

| Export | Behavior |
| --- | --- |
| `OFFLINE_NODE_IMAGE`, `OFFLINE_NODE_VERSION`, `DOCKER_ENGINE_VERSION` | Verified cached image/runtime pins; no pulling/building/updating. |
| `CLIENT_VERSIONS`, `CLIENT_ENV_ALLOWLIST` | Exact pilot client versions and narrowly named client variables; no environment harvesting or automatic credential retrieval. |
| `IsolationError` | Infrastructure `ContractError` with stable `code`. |
| `validateIsolationProfile(profile, {mode?})` | Consumes the existing semantic profile. Offline requires `auth: 'none-offline'`. Caps wall time at 300 seconds/concurrency at 4. Live fails closed. |
| `assessClientCapabilities({client,version,help})` | Rejects actual version drift, checks literal help flags, records help hash/missing capabilities. Help is capability evidence, **not** credential/tool containment acceptance. OpenCode permission behavior needs a config probe. Always reports live unsupported. |
| `buildClientEnvironment({client,values,profile,mode?})` | Explicit allowlist, no inherited environment, fixed isolated HOME/XDG/client paths. Credentials rejected offline; live profile checked **before** looking at values. Not an auth injector. |
| `materializeAgentContext(loadedSuite)` | Copies only declared provided **agent** dependencies as bytes; preserves explicit `mountRoot`, defaults to workspace; excludes trusted grader-private dependencies and automatic directories. The historical `judge` visibility value names that private namespace, not an AI grader. Caller adds selected skill snapshot bytes explicitly. |
| `createWorkspace({task,inputs?,config?})` | Fresh UUID directory under this tooling's `evals\.work`, marker, input/home/config/Docker-config/evidence children. Task has invocationId/caseId/client/arm/repeat. Explicit `{path,content,executable?,mountRoot?}` files only; no host-directory/home mounts or symlink copying. |
| `destroyWorkspace(handle)` | Deletes only an authentic inactive owned handle. Never sweeps `.work` or removes another invocation. |
| `recoverOwnedContainers(handle)` | Label-checks and removes only outstanding container names recorded by this handle, then proves absence. Allows safe workspace cleanup after a recoverable daemon failure; no global pruning. |
| `buildDockerArguments({profile,workspace,command,containerName})` | Fixed security arguments, never arbitrary caller Docker flags/mounts. Exposed for adapter inspection/tests, not a network override. |
| `createExecutor(profile, {mode?})` | Returns `{profileHash,run}`. `run({workspace,command,runtime,signal?})` enforces concurrency/time/output caps, actual pins, inspected confinement and label-scoped cleanup. One execution per workspace. |
| `redact(value,secrets?)` | Recursive credential-field/header/URL redaction and exact explicit secret/plain/URL/base64 matching. Redaction is defense in depth, not containment of arbitrary encodings. |
| `writeEvidence(handle,evidence,{secrets?,name?}?)` | Exclusive, size-bounded JSON persistence **after** redaction; owned contained paths only. No raw transcript persistence. |
| `assertClientRuntimeEvidence(result,profile,client)` | Rejects offline probes as normalized authenticated client evidence. No current executor result can satisfy live authentication. |

Input maximum: 256 files and 1 MiB total. Output maximum: 1 MiB per Docker
command; exceeding it terminates the attach process and removes the owned
container. Container limits: 256 MiB RAM/no additional swap, one CPU, 64 PIDs,
256 file descriptors, 1 MiB individual file writes, four 16 MiB tmpfs areas.
Wall time includes queueing/probes/execution; bounded owned cleanup has separate
10-second command deadlines. Turns/tokens are not applicable to offline probes.
Live adapters must demonstrate supported turn/token enforcement rather than
silently treating these contract limits as implemented.

Containers have read-only rootfs, UID/GID 10001, all capabilities dropped,
no-new-privileges, no IPC sharing, no Docker logs, and `--network none`.
Only fresh owned workspace/HOME/config seeds are bind-mounted read-only, with
recursive submount inclusion disabled. Workspace, HOME, client-config and scratch are new
noexec/nosuid/nodev tmpfs mounts, discarded per container. Config is a read-only
seed at `/eval/config`, **not** a reused personal config home. The trusted
bootstrap materializes it into separate `/client-config`. Future adapters must
verify their synthetic client config and intended discovery locations.
No Docker socket or host home is mounted. Seed file hashes/sizes are rechecked
before Docker create; added files, hardlinks, missing files and symlinks fail
closed. The host Docker CLI uses a fresh empty `DOCKER_CONFIG` and a fixed
local daemon endpoint; provider/host credential environment is not inherited.

Cancellation/timeout kills the attach CLI, then force-removes only containers
whose isolation label matches the owned workspace, and verifies they are gone.
If daemon cleanup cannot be proven, execution errors as `CLEANUP_FAILED`.
Keep the workspace for diagnosis; `destroyWorkspace` refuses until outstanding
containers have been recovered through `recoverOwnedContainers`.
Hard process termination/power loss can bypass JS cleanup; marker/labels allow
manual owned recovery, not global pruning.

### Explicit fixture roots and client configuration

`mountRoot: 'home'` maps a relative dependency such as `AI\README.md` into
the synthetic HOME seed. `mountRoot: 'workspace'` (the default) maps it into the
workspace seed. There is **no magic `home/` prefix**: `home\AI\README.md` with
omitted mountRoot is an ordinary workspace path. Traversal, absolute paths,
case-insensitive duplicates/ancestor collisions, unknown roots and auth files
are rejected. Different roots may intentionally use the same relative path.

A trusted Node bootstrap copies the three read-only seeds into fresh container
tmpfs areas before the version probe and again before task execution. Input
source mounts stay immutable; workspace copies can be modified by offline
Node. No probe-generated HOME/config/workspace state is reused by the task.
This launcher therefore requires Node in its pinned image, including any future
client image; images without Node are unsupported rather than launched unsafely.

Fixture HOME is `/home/eval`; client configuration is **separate**
`/client-config`, with fixed CLAUDE_CONFIG_DIR/COPILOT_HOME/XDG paths. Config seeds
are explicit synthetic bytes, not client auth stores. Fixture HOME cannot carry
`.claude`, `.copilot`, `.config` or `.local` stores; obvious credential/auth
filenames are rejected in all seeds. Treat all readable seeds as agent-visible.
Judge material is excluded, not routed to an accidentally readable subdirectory.
Only approved synthetic/selected input bytes should be passed: these primitives
cannot identify every possible secret encoded into caller-supplied content.

## Restricted text-only client boundary

The eventual pilot may expose **Skill + fixture Read only**, never arbitrary
Bash/shell/task/network tools. Verify the pinned runtime's actual tool names,
flags/config behavior, filesystem restrictions, absence of delegated execution,
and credential-access denials before supplying credentials. Do not translate
normalized `fixture-read` into an unverified actual tool name.

Known host surfaces to verify in the eventual pinned container:

- Claude 2.1.291: `--bare`, `--restricted`, `--permission-mode dontAsk`,
  `--permission-prompts none`, `--strict-mcp-config`, `--tools`, `--allowedTools`, `--disallowedTools`.
  Bare/direct API and restricted filesystem behavior need actual acceptance.
- Copilot 1.0.92: direct BYOK provider variables; `--available-tools`,
  `--excluded-tools`, `--deny-tool shell`, `--disallow-temp-dir`,
  `--no-custom-instructions`, `--disable-builtin-mcps`, `--no-auto-update`,
  `--no-ask-user`. `--secret-env-vars` masks output, not access.
- OpenCode 1.14.28: deny-all permissions, only exact fixture reads and intended
  skills allowed, `external_directory` denied, isolated XDG. Help alone cannot
  prove this config works.

None of those flag lists is an implemented client adapter or permission proof.
Host Claude/Copilot help was checked on 2026-10-07: the listed literal flags
exist; Claude help enumerates `dontAsk`/`none`. Restricted mode removes
code-running tools/WebFetch **unless explicitly named with --tools**, and
ignores ordinary settings while retaining managed/explicit settings; strict MCP
configuration is needed too. These caveats reinforce the need to verify the
actual container tool set, not blindly combine permissive flags.
Offline arbitrary Node execution is allowed solely because there are no
credentials/network and only synthetic inputs; do not reuse it as a live
tool policy.

## Offline verification

From `C:\Repositories\ai\evals`:

```powershell
node --test tests\isolation.test.mjs
$env:EVAL_ISOLATION_DOCKER = '1'; node --test tests\isolation.test.mjs
```

The first command runs unit/ownership/profile/redaction checks; actual Docker
tests are explicitly skipped unless opted in. The second runs those tests plus
real hardened containers, proving sentinels/host paths/credential-store paths
and network access absent, read-only inputs/rootfs, non-root/capability policy,
fresh HOME/workspace, version drift rejection, bounded output, timeout,
cancellation, concurrency, and label-scoped cleanup. It uses no model keys or
paid calls. A successful Node probe is **not** authenticated Claude/OpenCode/
Copilot acceptance.

All smoke files are isolated synthetic data under owned `.work` children.
The tests remove only their own handles; unrelated files/containers remain.

Observed on 2026-10-07: **22/22 targeted tests passed**, including eight real
Docker tests (no skips with opt-in). Node 22.22.1 and Docker 29.7.2 were observed
inside the pinned execution path. The smoke rejected four synthetic network
targets, absent host-sentinel/credential paths, rootfs/input writes, runtime
drift, output overflow and reused workspaces; timeout/cancellation cleanup and
an independently running owner's survival were verified. No model calls were
made. An initial Windows Docker-attach SIGTERM hang was fixed by forced CLI
termination plus cleanup independent of its close event; the bounded tests
passed afterward.
