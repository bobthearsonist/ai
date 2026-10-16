# Offline deterministic artifact checks

Import explicitly from `evals/harness/checks/index.mjs` (not the shared harness
index). No runner, client, subprocess, candidate code, network, or grader DSL is
executed.

```js
import {
  validateChecks, captureArtifacts, readCapturedArtifact, gradeChecks, executeChecks
} from './harness/checks/index.mjs';

const checks = [
  { id: 'answer', class: 'correctness', type: 'artifact-exists',
    target: 'answer.md', expected: true },
  { id: 'no-push', class: 'safety', type: 'artifact-not-contains',
    target: 'answer.md', expected: 'git push' }
];
const capture = captureArtifacts({ artifactRoot: approvedOutputDirectory, checks });
const result = gradeChecks({ checks, capture });
// Equivalent immediate capture + grading:
const immediate = executeChecks({ artifactRoot: approvedOutputDirectory, checks });
const independentBuffer = readCapturedArtifact(capture, 'answer.md');
```

## API and semantics

- `validateChecks(checks)` returns a deeply frozen declaration copy; invalid
  schemas, duplicate IDs, ambiguous artifact paths/aliases, nonfinite values,
  wrong expected types, and empty content literals throw `ContractError`.
- `captureArtifacts({ artifactRoot, checks })` returns an opaque in-process
  handle with frozen `{captureId, declarationsHash, artifacts}` metadata.
  Records contain `target`, `state` (`present`, `missing`, `error`), and for
  present files `sha256` and `bytes`; errors contain `reason`.
- `readCapturedArtifact(capture, target)` returns a fresh `Buffer` copy of a
  present artifact or throws. Mutating it cannot change grading storage.
- `gradeChecks({ checks, capture })` requires the original handle and exactly
  matching declarations. It returns frozen `{checks, evidence}`. Each outcome
  is `{id, class, status, evidence}`; evidence is a nonempty hash-bound reference.
  `evidence` is `{captureId, records}` with each record containing `ref`,
  `captureId`, `declarationsHash`, `checkId`, `target`, `status`, and artifact
  metadata or an unsupported-check reason. Persist this bundle alongside
  normalized outcomes; references alone are not durable evidence storage.
- `executeChecks({ artifactRoot, checks })` captures and grades immediately.
  Candidate-written check outcomes are not an input.

`artifact-exists` expects a boolean. A missing file passes only when absence was
expected; an existing regular file fails that negative expectation.
`artifact-contains` and `artifact-not-contains` expect nonempty UTF-8 literal
strings and perform exact byte-substring comparisons, not regexes, normalization,
prose interpretation, or semantic grading. Missing or unreadable content errors,
including negative content checks. Directories, devices, and symlinks error;
even contained symlinks are deliberately unsupported. Both path separators are
accepted but traversal, root paths, drive/UNC paths, Windows device names,
alternate data streams, invalid characters, repeated separators, dot segments,
and trailing dots/spaces are rejected.

`trace-event` and `manual-evidence` are schema-validated but always return
`error`: no trusted event provenance or manual attestation adapter is accepted.
Candidate prose, trace files, and self-reported success cannot satisfy them.
There are no skipped checks in this implementation.

## Trust boundary and limitations

The trusted caller chooses the artifact root and declarations and invokes this
module outside candidate execution. It captures declared files once, retaining
private immutable base64 byte copies; every grading read verifies length and
SHA-256. Later changes to filenames or returned buffers do not affect outcomes.
Handles cannot be reconstructed from JSON; serialized or forged captures are
rejected rather than treated as trusted bytes. Capture identity binds exact
content hashes, absence/error state, and the full declaration list.

This is logical in-process integrity, **not physical isolation** against
arbitrary same-host code, monkey-patching, privileged filesystem attackers, or
concurrent writers that can conceal changes. Metadata/containment checks detect
ordinary capture-time changes but do not promise an atomic filesystem snapshot.
Missing-file evidence records absence observed during capture, not eternal
absence. The caller must quiesce output or supply an isolated immutable output
tree. A hash identifies content; it does not authenticate client provenance.
Authentic native traces, real client execution and runner selection remain
blocked on separate adapters and execution acceptance. No model grades results.

The targeted test runs all cases in the three actual pilot suites against their
private good/broken artifact specimens through this executor. These fixed
unit-test examples establish objective discrimination, not client behavior.

```powershell
node --test --test-reporter=dot C:\Repositories\ai\evals\tests\checks.test.mjs
```
