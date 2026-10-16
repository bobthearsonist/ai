# Offline Profisee delivery checks

This is an independent, deterministic packaging gate. It needs no client,
authentication, baseline approval, model, native plugin evaluator or hosted
gateway. Gateway variants are **payload checks only**, never executed.
The root harness CLI and semantic contract are unchanged.

## Run

Requirements: Node 22+, the existing evals dependencies, Git, and either:

- Docker Desktop's Linux engine plus the packaging dependency image below, or
- Bash with `awk`, `find`, `sort`, `cp`, `mkdir`, `rm`, `mktemp`, `jq` and `zip`.

From `C:\Repositories\ai\evals`:

```powershell
node --test tests\packaging.test.mjs
node harness\packaging\cli.mjs check --repo C:\Repositories\profisee-ai --runtime bash
```

The tests locate synthetic source-owned answer keys at the sibling
`profisee-ai\evals\packaging\fixtures.json`. Override
`PROFISEE_PACKAGING_FIXTURE` for another layout. `PROFISEE_PACKAGING_REPO`
overrides the optional read-only real-export test's repository. Tests and
validation are offline; tests do not require any generator tools.

The optional automated **real-generator** test also mutates the actual
disposable output to prove missing-resource and plugin/ZIP eval-data rejection:

```powershell
$env:PROFISEE_PACKAGING_GENERATE = '1'
node --test tests\packaging.test.mjs
Remove-Item Env:\PROFISEE_PACKAGING_GENERATE
```

It uses Docker and the dependency image; optionally set
`PROFISEE_PACKAGING_IMAGE`. The default test run skips only this generator test.
Real export tests read the canonical repo without modifying it. A disposable
local Git index borrows existing read-only objects to test tracked dirty bytes
and explicitly selected untracked resources; it creates no commits/shared refs.

If the chosen generator validation fails because `jq` or `zip` is missing,
build the scoped dependency image instead of installing into the host:

```powershell
docker build --tag profisee-evals-packaging:local harness\packaging
node harness\packaging\cli.mjs check --repo C:\Repositories\profisee-ai --runtime docker --image profisee-evals-packaging:local
```

Image creation fetches Alpine packages once; generation itself has **no
network**. The Dockerfile pins the base digest and direct tool versions.
The gate resolves the supplied image to its immutable local SHA-256 identity
before launching. Transitive Alpine dependencies are not independently pinned;
record the returned image identity when comparing runs.
Only the owned snapshot is mounted: no home, Docker socket, other checkout,
personal auth/configuration or running service. The container is read-only
except that mount, nonroot, capability-free, and constrained to 128 processes,
512 MiB, two CPUs and a 180-second generator timeout.
This is a deterministic generator boundary, **not** proof of containment for
untrusted agent execution. Only run reviewed generator scripts.

The default Docker image is `profisee-evals-packaging:local`; the helper never
downloads/builds it automatically. `--runtime bash --bash <executable>` is
available when the local dependencies already exist. It inherits the process
environment, so prefer the offline Docker route; it is not an agent sandbox.
Failures exit 1, successful checks exit 0. JSON includes content identity,
per-file hashes/origins, selected dirty/deleted paths, exact generator hashes,
runtime image identity, counts and failures. None of this approves a baseline.

## Current bytes and disposable ownership

`createPackagingExport` calls the existing `exportCandidate` API with precisely
the tracked `skills`, `agents`, `scripts\build-plugins.sh` and
`scripts\build-desktop.sh` paths. Current tracked dirty/staged bytes are included;
HEAD is provenance only. Untracked files are **excluded by default**.
Use repeated `--untracked <file>` only for explicitly reviewed source files
under `skills` or `agents` (directories/globs are not implicit selections):

```powershell
node harness\packaging\cli.mjs check --repo C:\Repositories\profisee-ai --untracked skills\my-skill\SKILL.md --untracked skills\my-skill\references\reviewed.txt
```

No docs, global configuration, generated plugins, marketplace, Desktop output,
evaluation suite, result or answer key is exported by this entry point.
Unrelated source edits remain untouched; an untracked skill does not
automatically become a package or baseline.

The contract initially exports into its approved `evals\.work` location.
The returned **unique owned export** is immediately moved into
`harness\packaging\.work\packaging-<UUID>\source`. Both existing source
generators run there, never in the canonical checkout. Their files remain
unmodified. `TMPDIR` is the snapshot's `.generator-temp` directory: the
generator's `mktemp` never writes to system temporary directories.
Exported source hashes are checked before and after generation.
On success/failure the exact owned child is removed; no global cleanup or
delete-all-work command exists. Parallel invocations have separate children.

For consumers that already hold an immutable exported source and generated
output, read-only validation does not need Bash or Docker:

```powershell
node harness\packaging\cli.mjs validate --source C:\owned\export --generated C:\owned\output
```

`source` must have a valid contract `snapshot.json`, selected source files and
both generator scripts. Output contains `plugins`, `.claude-plugin` and
`desktop-bundles`. The reader never extracts ZIP contents to disk.

## Exact mapping and fail-closed policy

The mapping follows the inspected generators, not assumed plugin behavior:

| Source | Plugin | Desktop |
| --- | --- | --- |
| `skills\<dir>\SKILL.md` and every sibling/recursive resource | Byte-identical at `plugins\<dir>\skills\<dir>\...` | Byte-identical under `<dir>\...` inside `<dir>.zip` |
| Skill-root `.mcp.json` | Promoted to regular plugin root, removed from its original skill path | Remains at `<dir>\.mcp.json` |
| Skill with root `.mcp.json` | Additional `<dir>-gateway` plugin; skill bytes unchanged, root MCP omitted | No second/gateway archive |
| `agents\**\*.md` | Byte-identical at `agents\<resolved-name>.md` in the resolved-name plugin | Not bundled |

Agent names use frontmatter `name`, then the filename without `.md`, or parent
directory for case-insensitive `AGENT.md`. Description parsing follows the
script's inline/quoted and folded/literal-block behavior; whitespace collapses
and descriptions truncate to 197 characters plus `...` when over 200.
Docker sets `LC_ALL=C.UTF-8` so Unicode truncation is character-based.
Script constants determine version, repository and marketplace metadata.
Unexpected script shapes, unsafe names and plugin-name collisions fail; the
gate never accepts a generator overwrite as equivalence.
Directories without `SKILL.md` are reported as documented skipped skills.

Every generated plugin manifest and sorted marketplace entry is compared as
JSON to its source-derived metadata and exact `./plugins/<name>` reference.
Every resource and MCP/agent mapping is compared by bytes. Extra/missing files,
unexpected directories/plugins/archives, misplaced MCP configs and any
`.mcp.json` anywhere in a gateway plugin fail. The generator only transforms
the **skill-root** MCP file; a nested MCP file is not silently stripped or
allowed in a gateway by the gate.

Desktop archives are read via their ZIP central directories, verifying exact
relative entry names, decompressed bytes, CRC and lengths, supported
store/deflate compression, and optional directory entries. Traversal, duplicate
entries, encryption, symlinks, ZIP64/multidisk archives, malformed bounds,
extra artifacts, and excessive decompressed sizes fail closed.
ZIP timestamps/compression bytes are deliberately not an equivalence test.

Known evaluation path segments (`evals`, `.work`, fixtures, answer keys,
results) are prohibited within delivered source/payloads. Exact inventory and
byte comparison also reject extra eval data under innocuous names or overwrites
of legitimate resources. Files outside the selected source delivery trees
are never copied into expected output. Synthetic tests include answer keys and
results outside delivery and prove that missing resources and leaked data fail
independently of generated Git diffs.

## Named ESM API

Import from `harness\packaging\index.mjs`:

| Export | Behavior |
| --- | --- |
| `PACKAGING_TRACKED_PATHS` | Frozen reviewed tracked selection. |
| `createPackagingExport({repo,untrackedPaths?})` | Uses contract export; returns owned `{directory,sourceDirectory,snapshot}` handle. |
| `inspectPackagingSource({sourceDirectory,snapshot?})` | Rehashes source; returns Maps of expected plugins/archives, marketplace, explicit source-to-payload rows, generator hashes and skips. |
| `generatePackaging(handle,{runtime?,image?,bash?}?)` | Requires an owned handle; invokes both existing generators, returns runtime identity. |
| `validatePackaging({sourceDirectory,generatedDirectory?,snapshot?})` | Read-only structured `{passed,exitCode,counts,failures,...}` report; default output is source directory. |
| `cleanupPackaging(handle)` | Removes only the exact owned invocation; arbitrary or reused handles rejected. |
| `checkPackaging(options)` | Export → generate → validate → scoped cleanup even on failure. |
| `extractFrontmatter(text,field)` | Script-compatible narrow frontmatter reader, not a YAML parser. |

`zip.mjs` additionally exports `readZipEntries(Buffer)` and `deliveryPath`.
No publishing, marketplace install, trust grant, live auth, native paid
evaluation or automatic baseline promotion is performed. Native plugin
runtime/discovery and deterministic behavior gates remain separate work.
