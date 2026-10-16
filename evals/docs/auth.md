# Native authentication preparation (not authenticated execution)

Import `harness\auth\index.mjs` directly. This layer prepares empty owned
directories and **operator command plans**, not credentials or execution.
It changes no client modules, CLI, shared schema, baseline, permission policy,
user settings, global configuration, environment of the parent process or
native account. Contract **v2 / exact three repeats** remains unchanged.

Normal native account/provider authentication is intended. No new evaluation
API key, AI judge, raw model API, gateway or proxy is required or implemented.
There is no automatic login, status execution, trust grant, baseline approval,
model selection, model call, entitlement check or paid consumption.

## API and integration

| Export | Behavior |
| --- | --- |
| `AuthError` | Infrastructure `ContractError` with a stable `code`; rejected values, subprocess output and credentials are not interpolated into errors. |
| `prepareAuthProfile({client})` | Supports only `claude-code`, `copilot`, `opencode`. Returns process-owned frozen `{id,directory,client}`. No caller root, environment, secrets, platform spoofing or auth assertions. |
| `describeAuthProfile(handle)` | Returns paths, replacement environment, pin, contract version/repeats, honest blockers and optional version/help evidence. Always `configured:true`, `authenticated:false`, `authenticationVerified:false`, `liveAccepted:false`, `liveSupported:false`. Never reads credential-file contents. |
| `planAuthCommands(handle,{executable?}?)` | Returns `{client,login,status,blockers,authenticationVerified:false,liveAccepted:false}`. Each plan contains `cwd`, `env`, `executable`, fixed `args`, operator/credential-store-isolation requirements and no secrets. Optional executable must be an absolute native executable path, not a shell/script wrapper. |
| `inspectAuthRuntime(handle,{executable})` | Opt-in trusted executable **version/help only**, in a pristine owned profile. Verifies the existing exact pin, bounds each command to 15 seconds / 256 KiB, returns hashes and fixed argument identities only. Never launches login, actual status, interactive UI, providers or models. |
| `requireAuthenticatedProfile(handle)` | Always throws `AUTHENTICATION_UNVERIFIED`. Neither directory preparation nor help evidence can authorize live execution. |
| `cleanupAuthProfile(handle)` | Removes only the authentic process-owned UUID child. Rejects forged/destroyed handles, changed markers, missing required children, junctions/symlinks and hardlinks before removal. No sweeping, revocation or global logout. |

Storage is fixed at `evals\harness\auth\.work\auth-UUID`, ignored by the
auth-owned `.gitignore`. Every client gets a separate HOME, workspace,
APPDATA/LOCALAPPDATA, XDG config/cache/data/state, Claude config, Copilot home,
GitHub CLI config and scratch directory. Only the ownership marker is written;
every profile directory starts empty. No settings, catalog, instructions,
skill tree, plugin, hooks or credential bytes are copied from personal HOME.
For OpenCode only, the replacement environment also fixes `OPENCODE_DB` to
`state\opencode-native.db` in that same owned profile. Its native auth store
remains under `XDG_DATA_HOME\opencode`; the database and its WAL/SHM sidecars
belong under the separate state directory. Preparation creates neither file.
This supported separation of native session state is **not credential/tool
isolation**, and inherits no ambient `OPENCODE_DB` or `OPENCODE_AUTH_CONTENT`.
Claude settings/permissions docs were fetched before implementation; **no Claude
settings file is created** by this layer.

```js
import {
  prepareAuthProfile, describeAuthProfile, planAuthCommands, cleanupAuthProfile
} from './harness/auth/index.mjs';

const profile = prepareAuthProfile({client: 'claude-code'});
const description = describeAuthProfile(profile);
const commands = planAuthCommands(profile, {
  executable: String.raw`C:\path\to\pinned\claude.exe`
});
// Present description and plans. Do not execute here.
// Keep the profile if an operator needs to review it; cleanup invalidates plans.
cleanupAuthProfile(profile);
```

A CLI `prepare-auth` integration can call preparation, description and planning
without any inspection subprocess. With no executable, the plan names `claude`,
`copilot` or `opencode` and reports `requiresExecutableResolution:true`.
The replacement environment intentionally has **no PATH**; unresolved names are
not launch-ready. Resolve an explicitly trusted installed native executable
before operator use. An absolute path is still not proof of an installed pin;
`runtimeVerified` means only the matching process-local version/help inspection
succeeded, not authentication or unchanged executable bytes.

The future launcher must use the **replacement** `env` verbatim with
`shell:false`; merging `process.env` or applying only selected `$env:` assignments
in an ordinary PowerShell session silently restores ambient tokens/configuration.
Only Windows `SystemRoot`/`WINDIR` bootstrap paths are copied; PATH, provider keys,
GitHub tokens, proxy settings, NODE_OPTIONS, instruction paths, account profiles
and client environment overrides are not inherited. A Windows native client may
need additional reviewed native dependencies to complete login; do not recover
them by inheriting a personal PATH.

There is no launch API or credential injection interface. A prepared host
workspace beneath this repository is **not a sandbox**; ancestor discovery,
managed policy, Windows credential services and unrelated process/OS state are
not proven isolated. Use a separately verified OS-account/container boundary
before authorizing real login. Do not blindly paste these plans into the
current personal client session.

## Supported ordinary plans and their limitations

### Claude Code 2.1.291

* Login: `claude auth login`, with normal native account prompts. No `--bare`,
  token generation, forced Console billing, auto-trust or permission bypass.
* Status plan: `claude auth status`. JSON/status/exit code are account status,
  not evidence of containment, subscription entitlement or pilot behavior.
  **Only `auth status --help` was executed here.**
* `CLAUDE_CONFIG_DIR` separates ordinary settings/session history and claude.ai
  login. Current official authentication docs explicitly warn that Console
  sign-in **without an API key** uses an Anthropic profile outside that config
  directory and may sign out an existing claude.ai login. Do **not** perform
  that sign-in on a shared personal OS account.
* Normal credentials use `.credentials.json` under `CLAUDE_CONFIG_DIR` on
  Linux/Windows, and a directory-keyed macOS Keychain entry with a file fallback.
  The file is owner-accessible; changing its directory does not create a
  separate privilege boundary from the native process's file tools. No
  credential file, keychain or managed setting was inspected or changed.

### GitHub Copilot CLI 1.0.92

* Login: `copilot login`, normal OAuth; no PAT requirement, stdin-token plan,
  offline BYOK substitution or automatic login.
* Account inspection plan: start native `copilot`, then manually enter `/user`.
  There is **no invented `copilot auth status` or noninteractive status flag**.
  Starting an interactive session can initialize native network integrations;
  this is a plan only, not a safe automated auth probe.
* `COPILOT_HOME` redirects file configuration, but OAuth is normally stored in
  the OS keychain under service **`copilot-cli`**, including Windows Credential
  Manager. Fallback plaintext storage can also occur if the keychain is
  unavailable; the module does not enable or inspect it.
* Official precedence is environment tokens, stored OAuth/keychain and
  **`gh auth token` fallback**. The harness supplies no GitHub tokens, a fresh
  `GH_CONFIG_DIR` and no PATH. This reduces ambient discovery; it is **not proof**
  that account-scoped credential services are isolated. Do not invoke `gh auth
  token`, copy its output or reuse the personal keychain.
* Host pinned-help blocker: the WindowsApps app alias exited without a usable
  captured semantic version, and the extracted official npm-loader failed in
  its installation layout. It was not repaired, installed or updated. This
  layer records **no successful host Copilot runtime verification**. Plans are
  grounded in official commands and the installed CLI help obtained through
  the authoritative documentation tool (`/login`, `/user`), not invented flags.
  Existing offline adapter proof remains separate and is not authentication.

### OpenCode 1.14.28

* Login: `opencode auth login`; the operator selects the native provider and
  supported authentication method. The pin also supports `--provider`/`-p`
  and `--method`/`-m`; this layer does not choose them without authorization.
  OAuth/account availability depends on the chosen provider and client version.
  An API-key-only provider is not converted into a new eval-key requirement.
* Status plan: `opencode auth list`. This lists stored provider credentials;
  it does **not** prove token validity, entitlement or successful model calls.
  **Only `auth list --help` was executed here.**
* Native credentials are stored in `~\.local\share\opencode\auth.json`; the
  pinned client uses XDG data/config paths. The harness points XDG paths at its
  empty owned directories and never reads auth.json. Provider settings belong
  in the native OpenCode config, not Claude/Copilot config or a new harness API.
* OpenCode also discovers environment keys, project `.env` and merged
  global/project/managed/remote provider settings. Empty HOME/env alone is not
  proof these sources or filesystem/tool access are contained. No provider
  plugin is installed, endpoint is overridden or account entitlement assumed.
  Official provider docs note Anthropic restrictions on third-party Claude
  subscription use; choose an officially supported native account method.

## Sources and observed help

Official documentation fetched **2026-10-08**:

* [Claude authentication](https://code.claude.com/docs/en/authentication),
  [CLI reference](https://code.claude.com/docs/en/cli-reference),
  [settings](https://code.claude.com/docs/en/settings),
  [permissions](https://code.claude.com/docs/en/permissions).
* [Copilot authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli),
  [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
* [OpenCode CLI](https://opencode.ai/docs/cli/),
  [config](https://opencode.ai/docs/config/),
  [providers](https://opencode.ai/docs/providers/).

`harness\auth\help-evidence.json` records actual version/help hashes, **not**
credential captures. Successfully observed host executables:

* Claude: existing versioned `C:\Users\MartinPe\.local\share\claude\versions\2.1.291`;
  only `--version`, `--help`, `auth --help`, `auth login --help`,
  `auth status --help`, each in a new owned profile.
* OpenCode: existing
  `C:\nvm4w\nodejs\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe`;
  same fixed surface with `auth list --help` in place of status.
* Copilot: unsupported host capture as described above; no successful pin/help
  hash claimed. The authoritative installed-client help lists `/login` and
  `/user`; current official docs support `copilot login`.

No actual auth-status command, network/auth test, native login, model/paid call,
baseline capture or personal credential read/copy was performed. Help is only
command-surface evidence; it does not prove network silence or authentication.
The command runner has no network sandbox and only accepts a trusted explicit
installed executable; arbitrary executable substitution is not a security
boundary. The helper must not be pointed at untrusted candidate code.

## Targeted validation and remaining gates

```powershell
node --test C:\Repositories\ai\evals\tests\auth.test.mjs
```

The initial 14 preparation tests passed on Windows. They cover empty separate UUID profiles,
zero launch during preparation/planning, replacement HOME/env with synthetic
ambient credential sentinels, no secrets in errors/evidence, native-only fixed
plans, unsupported fields/clients, bounded help-only inspection, version drift,
missing command surface, configured-vs-authenticated distinction, forged/reused
handles, marker corruption, missing children, junction/symlink and hardlink
protection, unrelated-owner survival, partial-preparation rollback and cleanup. Mock subprocess tests are
explicitly **unit tests**, not actual pinned-runtime or authenticated acceptance.

Live execution still needs a separately verified native-login/OS credential
boundary, restricted tools/direct endpoint egress, native turn/token/consumption
limits, explicit operator spend authorization, exact human baseline approval,
and actual deterministic per-repeat pilot behavior/evidence. This module cannot
relax those gates or promote offline probes/help/auth metadata into acceptance.

## Process-owned custody for future admitted native runtime

Import `harness\auth\custody.mjs` directly. This additive interface preserves
all original preparation APIs; it is **not** an authenticated broker or a
credential import/mount API.

```js
prepareNativeAuthCustody({client, evaluation})
describeNativeAuthCustody(handle)
assertNativeAuthCustody(handle, {client, evaluation})
requireNativeAuthenticatedCustody(handle, {client, evaluation}) // always throws
releaseNativeAuthCustody(handle)
```

`evaluation` must be the **original active process-owned** handle returned by
`prepareLiveEvaluation` in `harness\live-execution.mjs`. The implementation
directly invokes its original `describeLiveEvaluation` verifier; callbacks,
copies, JSON reports, auth booleans, credential paths/values, provider overrides,
host profiles/keychains and caller-supplied status receipts are not inputs.
Unknown fields, accessors and proxies are rejected.

Preparation creates its own new empty evaluation-only profile under the fixed
auth-owned root. Its legacy profile handle is retained privately, never returned
or recoverable from the public custody handle. Custody handles expose only
`{id,client}`, and are authenticated by an original WeakMap entry, not their
fields. There is no native command or subprocess in this lifecycle.

Descriptions/assertions return only:

```js
{
  kind: 'isolated-native-auth-custody', id, client,
  phase: 'prepared-unverified',
  binding: {
    invocationId, planHash, profileHash, client, clientVersion,
    model, endpoint, requestedImage, taskSessionCount
  },
  bindingHash,
  configured: true,
  nativeRuntimeVerified: false,
  authenticationVerified: false,
  nativeLoginExecuted: false, nativeStatusObserved: false,
  credentialsImported: false, credentialStorageVerified: false,
  refreshVerified: false,
  rootRuntimeAccessVerified: false, evaluationToolAccessVerified: false,
  candidateAttachmentSupported: false, liveAccepted: false,
  blockers: [/* fixed nonsecret explanations */]
}
```

The exact evaluation plan hash binds source snapshots, selection, limits and
routes. Each assertion rechecks the active original evaluation, client pin,
captured binding and private profile ownership. A different genuine evaluation
handle is rejected even if its report has equivalent fields. Profiles must
remain **empty**: native-state files cannot be supplied as auth proof.
Descriptors expose no storage paths, environment, opaque auth bytes or account
identifiers; do not substitute the older host preparation description for a
custody/admission report.

Release verifies ownership/links and removes only the private profile owned by
that custody. It remains available after the evaluation is released first, but
forged/released handles and unexpected/linked storage fail closed. It performs
no global logout, revocation, keychain cleanup or credential harvesting. Failed
release leaves ownership active for safe diagnosis/retry. Custody is not
recoverable in another process.

Authority remains separate:

* `assertNativeAuthCustody` proves **custody and binding only**, never account
  authentication, candidate attachment, spend authority or baseline approval.
* `requireNativeAuthenticatedCustody` always throws
  `AUTHENTICATION_UNVERIFIED`; there is no fabricated status receipt or state
  setter. Actual native observed authentication requires future concrete
  admitted-runtime implementation and exact operator-issued auth authorization.
* Public protocol/storage findings below are **static feasibility evidence**.
  Actual Linux native store/keyring/fallback behavior, status, refresh and
  login/refresh proxy compatibility remain unobserved for each admitted runtime.
  Existing host help does not resolve those live requirements.
* Intended client-native paths such as Copilot `/client-config/copilot` or
  OpenCode `/work/data` are not verified authenticated stores or approved
  attachment roots. No `authRoot` can be obtained from custody at this stage.
* Root native-runtime access to OAuth storage must be measured independently
  from evaluation tools. A root/native process needing credentials does not
  authorize Read/shell/Skill or candidate source/output access to them.
* The network owner retains original production egress-boundary and candidate
  attachment authority; custody neither invents a boundary receipt nor mounts
  credentials. The future integration must validate both original authorities.

Additional errors: `INVALID_CUSTODY_OPTIONS`, `INVALID_AUTH_EVALUATION`,
`AUTH_BINDING_MISMATCH`, `AUTH_STORAGE_UNVERIFIED`, `AUTH_CUSTODY_OWNERSHIP`,
`INVALID_AUTH_CUSTODY`, `AUTH_CUSTODY_CLEANUP_FAILED`, plus the existing profile
ownership errors. All errors are fixed nonsecret messages.

Focused validation now contains **20 auth tests**: the original 14 plus five
custody tests exercising genuine preparation handles for all three clients,
no native subprocess during custody, exact-original binding, forged/proxy/
accessor/proof/import rejection, secret-free descriptions, unobserved storage
rejection, evaluation-before-custody release, and linked-storage/unrelated-owner
protection, plus the OpenCode native-auth/session-state separation regression.
These are deterministic unit tests, not native auth acceptance.
No native login/status/provider/model/billing/network calls or probe/matrix
reruns were performed for this continuation.

The focused continuation command (with serial file execution because these
tests share the fixed owned auth preparation root) is:

```powershell
node --test --test-concurrency=1 --test-reporter=spec C:\Repositories\ai\evals\tests\auth.test.mjs C:\Repositories\ai\evals\tests\native-auth-profiles.test.mjs
```

Result: **26 passed, 0 failed/skipped** (20 auth and six directly related
preparation/CLI tests). `node --check` also passed for the changed auth module
and test. No native executable was invoked by these tests; version/help
subprocesses are mocked, and real CLI subprocesses run only the local harness.

## Pinned normal-native broker feasibility (2026-10-09)

**Admission remains blocked.** No login, status, refresh, account, model or
provider request was executed. Public HTTPS GETs to documentation, GitHub
source/releases and npm distributions establish the facts below, not native
authentication or effective containment. No personal credential/auth file,
keychain, environment secret or account was read. Downloaded public package
bytes were inspected only in memory, never run or retained in an image.

The repository pins were checked in the actual client modules:
`clients\claude-code\policy.mjs` (`CLI_VERSION = '2.1.291'`),
`clients\copilot\index.mjs` (`VERSION = '1.0.92'`) and
`clients\opencode\constants.mjs` (`CLIENT_VERSION = '1.14.28'`).
They are requested pins, not observed admitted-runtime versions.
Historical help receipts, public-package identities and passing unit/offline
tests do not upgrade that authority.

### Claude Code 2.1.291

* Ordinary `auth login` retains subscription/account OAuth. `--bare`,
  `setup-token`, `apiKeyHelper` and key/token environment substitution are not
  equivalent routes. The [CLI reference][claude-cli] describes `auth status`
  as JSON, exit 0/1 for logged-in/not-logged-in, with `authMethod` and
  `configDirectory` (the latter supported since 2.1.268). Those fields need
  a fresh original native observation; they do not establish tool containment,
  entitlement, observed model or usage.
* [Credential management][claude-auth] documents Linux mode-0600 storage,
  Windows user-profile ACLs, and the macOS Keychain/file fallback. Ordinary
  account credentials belong under `CLAUDE_CONFIG_DIR`; keyless Console
  profiles instead use the separate Anthropic configuration directory.
  The public Linux artifact contains the native `.credentials.json` storage
  path, `claudeAiOauth` state and compare-and-save refresh-token mutation.
  Its OAuth constants include the account authorization origin
  `https://claude.com/cai/oauth/authorize` and native token endpoint
  `https://platform.claude.com/v1/oauth/token`. These are routing requirements,
  not instructions to send a raw request or a new harness auth protocol.
* `--tools` restricts available tools; `--disallowedTools` denies tools.
  [Permissions][claude-permissions] enforce Read/Edit rules in native code.
  Read denies cover Read and (in this pin's supported version range) Edit/Write;
  `Edit` is the file-modification rule, **not `Write(path)`**. Coverage of other
  readers, including Grep/Glob and attached context, is documented as
  best-effort. Skill loading and dynamic context are separate surfaces, not
  evidence that every secret read traverses the Read tool.
* The [Bash sandbox][claude-sandbox] expressly excludes Read/Edit/Write,
  MCP, hooks, LSP and helpers. Wrapping the whole CLI also wraps its native
  authentication access; it does not give in-process file tools a different
  filesystem principal. A same-UID mode-0600 file and empty HOME therefore
  cannot satisfy an independent credential-versus-tool boundary.

### Copilot CLI 1.0.92

* [Normal OAuth][copilot-auth] is `copilot login`/`/login`; browser callback
  and device-code flows are supported. The normal Linux account store is
  `libsecret` under service `copilot-cli`; macOS uses Keychain and Windows
  Credential Manager. A native plaintext fallback can use
  `COPILOT_HOME\config.json` when the keychain is unavailable. Redirecting
  `COPILOT_HOME` does not partition a shared OS keychain.
* `/user` is the supported account-inspection plan. No `copilot auth status`,
  standalone refresh command, external OAuth JSON schema or caller-supplied
  status receipt is adopted. Current docs describe remembered native login
  and token lifetime governed by token/account policy; they do **not**
  establish a version-bound external status/refresh broker interface.
  The public pin's native executable packages its application payload; an
  absent plaintext string in that executable is not evidence that a protocol
  or capability does not exist.
* Ambient `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, BYOK settings and
  `gh auth token` fallback are not the required isolated normal login.
  The prepared replacement environment imports none of them. Installing a
  keyring service or selecting native fallback storage would be a separately
  authorized runtime/account operation, not a host-store import.
* [Tool availability][copilot-programmatic] supports `--available-tools`,
  `--excluded-tools` and `--deny-tool`. These are not OS credential isolation.
  The [sandbox filesystem documentation][copilot-filesystem] explicitly
  distinguishes OS-sandboxed shell/search children from in-process file
  operations that check policy **in software only**. Subagents inherit the
  distinction according to their tools.
* [Credential masking][copilot-sandbox] is for sandboxed Git/`gh` and selected
  environment variables. It is not a broker that moves Copilot's own normal
  login/keychain/refresh state out of its agent process. Bypass is enabled by
  default, and developer-tool grants can include credential-bearing package
  configuration. Neither masking nor a saved sandbox setting proves that the
  actual task tool inventory is contained. No such settings were changed.

### OpenCode 1.14.28

All source links in this subsection are pinned to `v1.14.28`, whose public
Git tree is `acd8783a36d8642ade7038f34ca4f2f2ac3cc824`.

* [`providers.ts`][oc-providers] defines `providers` with alias `auth`, native
  `login [url]`, `--provider`/`--method`, `list` and `logout`. Account methods
  come from native plugins; selecting an arbitrary provider is not proof it
  supports account OAuth. The login path can refresh the models catalogue
  before provider selection. `auth list` enumerates stored provider/type and
  active environment-variable names, not access-token validity or entitlement;
  it calls `ModelsDev.get`, so it is not assumed network-free.
* [`Auth.Service`][oc-auth] exposes native `get(providerID)`, `all()`,
  `set(key, info)` and `remove(key)`. Its OAuth record contains
  `type:'oauth'`, `refresh`, `access`, `expires` and optional account/enterprise
  metadata. It reads/writes `Global.Path.data\auth.json`, using mode 0600.
  [`Global.Path.data`][oc-global] is `XDG_DATA_HOME\opencode`, independent of
  the native session database. [`OPENCODE_DB`][oc-db] accepts an absolute path;
  the preparation layer now binds it to its own separate state directory.
  Native `OPENCODE_AUTH_CONTENT` is an inline store override, **not an allowed
  harness input or imported environment variable**.
* [`Plugin.Service`][oc-plugins] always initializes first-party internal auth
  plugins before applying `OPENCODE_PURE` to the external plugin list. `--pure`
  does not remove Codex/Copilot native auth. No auth plugin is replaced.
* The native [Codex plugin][oc-codex] supports ChatGPT browser PKCE/loopback and
  headless device authentication. It renews an absent/expired access token
  through `https://auth.openai.com/oauth/token`, writes rotated state through
  `input.client.auth.set`, and uses the native ChatGPT Codex service. The native
  [Copilot plugin][oc-copilot] uses GitHub device authorization and native
  GitHub Copilot requests; its persisted record puts the GitHub OAuth token
  in `refresh` and `access` with `expires:0`. Do not infer a generic refresh
  protocol, token lifetime or provider-wire identity from those field names.
  These are first-party plugin facts, not raw-provider substitutes.
* [`read`][oc-read] asks `read` with a file-path pattern and
  `external_directory`; [`write`][oc-write] uses `edit`, with the relative
  worktree path. Write reads an existing file and constructs its diff **before**
  asking the Edit permission. Thus a Read deny alone is not a general
  credential read boundary, and the outer external-directory guard matters.
  [`skill`][oc-skill] asks by skill name and returns catalogued content;
  [`grep`][oc-grep] asks by regex and external directory, not Read permission.
  [`evaluate`][oc-permission] uses the **last matching** rule, and
  [agent-specific permissions][oc-agent] are appended after global rules.
* On Linux, the [external-directory guard][oc-external] uses the supplied path;
  [`contains`][oc-filesystem] is a lexical relative-path check, not a realpath
  credential-root verifier. Untrusted links/aliases, mutable policy/config,
  built-in instruction loading, LSP/formatters, and enabled search/subagent
  tools cannot be certified by a single Read-path deny. These code paths and
  native auth run under the same application/process filesystem authority.

### Exact blocker and integration consequence

The supported controls above permit **native software-denial policies**, not
a demonstrated OS-separated broker for credential-bearing in-process
Read/Skill/Write operations. The current runtime must not mount/adopt an auth
root on the theory that shell sandboxing, HOME/tmpfs, file mode, declared path
rules or an opaque handle already prove that separation.

This is a precise architecture/admission blocker, not a claim that native path
controls can never work. A human must decide whether independently measured,
immutable, capability-complete **native software enforcement** is an acceptable
credential boundary, or whether the stronger independent-OS-principal
requirement remains. In the latter case, the inspected native in-process tool
surfaces do not supply that split without a different architecture. In the
former case, every enabled reader/writer, automatic context source, policy
override, credential alias and helper still needs original supervised denial
observations before login/task admission.

No new controller, imported-store adapter, fabricated refresh command,
caller-proof callback or planning-only policy-binding API is added to conceal
this blocker. The exact existing original-scope contract remains:

```js
prepareNativeAuthCustody({client, evaluation}) // original active evaluation
assertNativeAuthCustody(custody, {client, evaluation}) // exact same originals
describeNativeAuthCustody(custody) // frozen nonsecret binding; all auth flags false
requireNativeAuthenticatedCustody(custody, {client, evaluation}) // always rejects
releaseNativeAuthCustody(custody) // original owned pristine storage only
```

`bindingHash` covers the captured requested plan/profile/client route; it is
not observed model, account, runtime, credential-root or tool-policy authority.
There is no additional runtime execution interface to integrate until the
boundary decision is resolved. The parent must keep rejecting on
`requireNativeAuthenticatedCustody`, rather than supply a proof-shaped callback
or booleans. An eventual action boundary would have to consume the original
active evaluation, native runtime/candidate, custody and separately issued
operator authorization together, derive its fixed native action internally,
and return an original verifier-owned nonsecret observation—not accept stdout,
JSON, token stores, `authRoot`, account IDs or flags as caller authority.
There is no supported generic `refresh` action established by this slice.

Before an operator-authorized normal isolated login:

1. Resolve that credential/tool boundary decision and verify it for the
   **complete effective native capability/config/context set**, including
   read and modification attempts with synthetic canaries.
2. Admit the original pinned native runtime/candidate and its actual
   executable/image/UID, owned native storage/keyring and measured egress
   policy. Model-service origins alone do not authorize the distinct login,
   token-renewal or catalogue origins described above.
3. Issue exact finite action/account/route/expiry authorization separately
   from baseline/trust/spend approval. Use native OAuth/provider account
   selection, with no personal credential imports or token/key substitution.
4. Route login codes, URLs, raw account output and credential/refresh state
   solely through a private operator/native channel, never candidate/model
   inputs, images, receipts, reports or retained host task evidence.
5. Obtain original native status, storage/refresh and tool-denial observations.
   Keep missing observed model/usage null. Unit tests, static public-source
   inspection and historical receipts cannot make this step pass.

### Static source identity versus runtime proof

Public Linux package SRI was checked against exact npm version metadata, and
the packaged native binary was hashed without execution:

| Public distribution | Packaged binary SHA-256 |
| --- | --- |
| [`@anthropic-ai/claude-code-linux-x64@2.1.291`][claude-npm] | `078fad28d0297c9a25d306b635b2d8816c6839347520f29eb54ffea5d56142fb` |
| [`@github/copilot-linux-x64@1.0.92`][copilot-npm] | `9f1552c5eae8d523fd807bfea53ad3e72960106fe492d1bd9cfa13534c534359` |

[Claude's release][claude-release] and [Copilot's release][copilot-release]
corroborate the requested versions. Public documentation is unversioned unless
explicitly marked; its described controls still require pin-specific original
runtime observations. These identities are **not** installed-image hashes,
help/status observations, authentication proof or end-to-end acceptance.

[claude-auth]: https://code.claude.com/docs/en/authentication
[claude-cli]: https://code.claude.com/docs/en/cli-reference
[claude-permissions]: https://code.claude.com/docs/en/permissions
[claude-sandbox]: https://code.claude.com/docs/en/sandboxing
[claude-npm]: https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/2.1.291
[claude-release]: https://github.com/anthropics/claude-code/releases/tag/v2.1.291
[copilot-auth]: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
[copilot-programmatic]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
[copilot-filesystem]: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/understanding-local-sandboxing
[copilot-sandbox]: https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings
[copilot-npm]: https://registry.npmjs.org/@github/copilot-linux-x64/1.0.92
[copilot-release]: https://github.com/github/copilot-cli/releases/tag/v1.0.92
[oc-auth]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/auth/index.ts
[oc-global]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/core/src/global.ts
[oc-db]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/storage/db.ts
[oc-providers]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/cli/cmd/providers.ts
[oc-plugins]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/plugin/index.ts
[oc-codex]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/plugin/codex.ts
[oc-copilot]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/plugin/github-copilot/copilot.ts
[oc-read]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/tool/read.ts
[oc-write]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/tool/write.ts
[oc-skill]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/tool/skill.ts
[oc-grep]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/tool/grep.ts
[oc-permission]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/permission/evaluate.ts
[oc-agent]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/agent/agent.ts
[oc-external]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/opencode/src/tool/external-directory.ts
[oc-filesystem]: https://github.com/anomalyco/opencode/blob/v1.14.28/packages/core/src/filesystem.ts
