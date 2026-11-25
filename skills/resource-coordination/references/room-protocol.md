# Room protocol and CLI

## Contents

- [Invocation and state](#invocation-and-state)
- [Action schema](#action-schema)
- [Concrete workflow](#concrete-workflow)
- [Immutable records and messages](#immutable-records-and-messages)
- [Claims and barriers](#claims-and-barriers)
- [Runtime scheduling](#runtime-scheduling)
- [Prepared candidate turns](#prepared-candidate-turns)
- [Stopped descriptor supersession](#stopped-descriptor-supersession)
- [Run scripts](#run-scripts)
- [Validation](#validation)

## Invocation and state

Require Python 3.10+ and local storage. Select the same root for every cooperating
client. Do not create a root per task. Use a dedicated directory with ACLs limited
to trusted participants; a shared cross-user root works only when all callers
explicitly select it. Resolve paths before elevation.

```text
python .\scripts\resource_room.py --root C:\Coordination\ResourceRooms --action inspect
python .\scripts\resource_room.py --root C:\Coordination\ResourceRooms --action join --request-file .\join-request.json
python .\scripts\resource_room.py --root C:\Coordination\ResourceRooms --action claim --request-file .\claim-request.json
```

Each invocation returns exactly one UTF-8 JSON envelope:
`{"ok":true,"action":"join","data":{...}}` or
`{"ok":false,"code":"Conflict","message":"..."}`.
Exit codes: **0** success; **2** invalid input/unsupported path or platform;
**3** conflict, queue, generation, barrier or required-yield failure;
**4** owner mismatch; **5** fault/inventory/pin/state/reconciliation failure;
**6** actively held lock or runtime users; **7** run-script native failure.
Adapter/script exceptions also exit nonzero; inspect the durable operation for
the original error and phase. A successful `request` means **queued**, not usable.

Programmatic callers can invoke the CLI without shell quoting:

```python
import hashlib
import json
import pathlib
import subprocess
import sys

def room(action, request=None):
    result = subprocess.run(
        [sys.executable, "scripts/resource_room.py", "--root", r"C:\Coordination\ResourceRooms",
         "--action", action, "--request-json", json.dumps(request or {})],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    envelope = json.loads(result.stdout)
    if result.returncode:
        raise RuntimeError(f"{envelope['code']}: {envelope['message']}")
    return envelope["data"]

claim = room("wait-claim", {
    "sessionId": session_id, "roomId": room_id,
    "resources": [{"kind": "path", "identity": r"C:\Work\library", "mode": "exclusive"}],
    "timeoutMs": 300000, "pollMs": 1000,
})
```

The helper exclusively owns `state.json`, a schema-2, host/root/boot-bound,
checksummed atomic snapshot. It contains sessions, rooms, claims, immutable room
records, append-only messages, registries, FIFO requests, runtime uses, the current operation, history and unique
event records. **Agents must never edit it directly**, including its checksum.
`state.lock` provides short cross-process exclusive transactions; `operation.lock`
is held throughout heavy work. Windows uses an exclusive file handle; POSIX uses
`flock`. Lock files are persistent and must never be deleted to force progress.
Owner metadata includes session ID, PID plus start time and a unique token.

Pending same-directory snapshots are written with exclusive create and flush,
then atomically replaced. A leftover `.pending` file is not authoritative.
The latest committed snapshot remains authoritative after a crash. Missing,
malformed or incompatible committed state fails closed. Events are unique
UUID-bearing records **inside** the transactional snapshot, not files that
agents append themselves. History currently grows without automatic pruning.
Python reads existing schema-2 snapshots using their stored raw-data checksum.
After the first Python mutation, every client sharing the root must use this
implementation; never mix coordinator releases against the same root.

## Action schema

Bodies are JSON objects. `sessionId` is required except on `inspect` and first
`join`. IDs returned by the helper are opaque; keep exact casing. Target IDs are
case-insensitive opaque strings (including colon/URI-style names), never filesystem
names; traversal segments and control characters are rejected. Adapter names use
ASCII letters, digits, dots, underscores or hyphens (maximum 128 characters).
Numbers below are JSON integers, booleans are JSON booleans, and arrays must remain
arrays even when empty/singleton.

| Action | Additional request fields | Ownership / result |
|---|---|---|
| `inspect` | none | Full snapshot, `bootMismatch`, `recoveryRequired`; no lifecycle calls |
| `join` | First session: `client`, `purpose`; new room: `name`; existing room: `roomId`; optional `roomKey` instead of `roomId`; optionally existing `sessionId`; optional `clientSession` (the harness's own session ID, stored on a new session); `recoverBoot:true` only for an unowned idle root after reboot | With `roomKey`, atomically create-or-join one canonical room; without it, create a distinct room; return `sessionId`, `roomId`, `roomKey`, `roomGeneration`, `nextCohortOnly`; recovery-only bootstrap also returns `recoveryOnly:true` without reconciling boot |
| `record` | `roomId`, `key`, `value:{}` | Member; create immutable room-keyed metadata; return record `id`; no replacement, even by creator |
| `message` | `roomId`, `text`, optional `data:{}` | Member; append immutable uniquely identified participant/result note; allowed during freeze/fault/boot mismatch |
| `claim` | `roomId`, `resources` | Member; atomically claim all or none; return claim `id` |
| `wait-claim` | `roomId`, `resources`; optional `timeoutMs` (default 300000, maximum 86400000), `pollMs` (default 1000, range 10–5000) | Retry a manual claim on transient contention; atomically claim all resources when available; return `claim`, `attempts`, and `waitedMilliseconds`; timeout exits 3 without a claim |
| `release` | `claimId` | Only owner, manual claims only |
| `cohort` | `roomId`, `expectedGeneration`, `candidate`, `cohort:[sessionIds]`, `resources` | At an idle candidate boundary, any member atomically becomes captain and creates the candidate; an existing unfrozen candidate remains current-captain-only; increment generation |
| `ready`, `unready` | `roomId`, `generation`, `candidate` | Explicit cohort member only; readiness promises to pause edits |
| `freeze`, `thaw` | `roomId`, `generation`, `candidate`; current `turnId`, `turnGeneration` when prepared | Barrier owner only; suspend contained participant edit claims during freeze; thaw requires stopped prepared runtime and restores them |
| `register-adapter` | `name`, absolute `path`, `sha256` | Trusted explicit registration; return immutable registry entry |
| `register-target` | `target` descriptor | Any member session; return immutable descriptor with `generation`; no lifecycle call |
| `supersede-target` | `targetId`, `fingerprint`, `descriptorGeneration`, replacement `target`; current turn token when prepared | Exclusive, unreferenced, verified stopped replacement; return `target`, updated `turn`; retain old descriptor in history. Optional `confirm: "EXPAND_STOPPED"` allows additive-only same-ID expansion of a stopped descriptor |
| `rebind-adapter` | `protocolVersion: 1`, `confirm: "REBIND_STOPPED"`, exactly one of `oldAdapter` or `oldAdapters`, `newAdapter`, exact `targets` | Read-only stopped proof followed by one atomic migration of every descriptor on the selected unusable pins |
| `request` | `roomId`, `targetId`, `fingerprint`, `descriptorGeneration`, `purpose`; optional `barrierGeneration`, `candidate` | No owned manual/freeze/turn claims or uses; one pending request/session; return `id`, `sequence` |
| `prepare` | `requestId` | Candidate request owner at FIFO head, zero runtime users; inspect/stop, reserve candidate+target resources without Start; return `turn`, `runtime` |
| `activate` | Ordinary: `requestId`; prepared: `turnId`, `turnGeneration` | FIFO requester or exact prepared owner with frozen candidate; inventory then activate/reuse; return `runtime`, `use` |
| `release-use` | `useId` | Use owner only; runtime stays warm |
| `cancel` | `requestId` | Pending request owner only; cannot cancel its executing/faulted activation |
| `release-turn` | `turnId`, `turnGeneration` | Exact owner; stopped/unfrozen only; cancel an unused prepared turn or release it after park/thaw |
| `park` | `runtimeGeneration`; current turn token when prepared | A successful current runtime participant, zero users; prepared turn owner only while reserved; fresh lease and verified stop |
| `run` | `roomId`, absolute `scriptPath`, `sha256`, `parameters:{}`, `effects`, `resources`; optional frozen `barrierGeneration`, `candidate`; current turn token when prepared | One heavy operation; atomic claims; details below |
| `leave` | none | Finish owned claims/uses/turns/requests/operations/cohorts; may leave while another successful participant remains; last participant automatically parks |
| `recover` | `confirm:"RECONCILE"`, `mode`, expected operation/runtime identity; mode-specific fields | Explicit owning session only; see [recovery](recovery.md) |

`resources` is an array of
`{"kind":"path"|"key","identity":"...","mode":"shared"|"exclusive"}`.
Every descriptor and operation must declare at least one actual physical resource.
Use one kind consistently for each physical resource; identical canonical identities
declared with different kinds conservatively conflict when either claim is exclusive.

`wait-claim` is for manual edit claims only; runtime access continues to use the FIFO
`request`/`activate` protocol. It retries only transient contention and commits the
claim in the same transaction that observes availability, so another participant
cannot take the resource between the check and acquisition. It holds no state lock
while sleeping and creates no persistent watcher record. Terminating it while
still waiting needs no watcher cleanup. Once acquisition commits, however, the
manual claim survives even if the client exits before receiving its reply:
inspect the same root/session and release your own claim rather than assuming
cancellation undid the transaction. Polling is not FIFO, so use runtime requests
only for runtime access, not manual edit fairness. Coordinate edit order explicitly
when multiple waiting editors require a guaranteed order. A timeout does not acquire
a partial claim.
`join` normally refuses a boot mismatch. If every session has departed and no
ownership or reservation remains, an explicit `recoverBoot:true` join can create
a new recovery-only session and room. It cannot select an existing session,
`roomId` or `roomKey`. Boot remains mismatched and new work remains blocked until
versioned recovery verifies registered inventory; see [recovery](recovery.md).
`target` has `id`, `fingerprint`, `adapter`, `resources`, `config:{}`, `state:{}`.
Initial state must be empty. `config` and subsequent adapter state are opaque JSON,
not command text or secrets. See [adapter contract](adapter-contract.md).

For a canonical execution room, pass the same opaque key on every concurrent first
join; do not implement inspect-then-create as a client-side uniqueness check:

```json
{"client":"copilot","purpose":"shared execution","name":"display label","roomKey":"workflow:<resolved-target-id>"}
```

Pass this object as the `join` request.

The existing state transaction performs key lookup, room creation and membership
addition atomically. Keys are immutable, full NFC-normalized case-insensitive
identities, not filenames; the returned/stored key is canonical uppercase.
`name` is required only if the room does not yet exist and never renames an
existing keyed room. `roomId` and `roomKey` are mutually exclusive. Unkeyed joins
retain distinct-room behavior even when display names match. Keyed joins preserve
metadata and frozen-cohort/late-member restrictions; they do not transfer existing
candidate ownership or recycle keys after departures. `room.owner` is the current
captain, initially the creator; a later `cohort` acquires the next captaincy as
described below, even if the previous captain has departed.

## Concrete workflow

Examples use the JSON CLI helper shown above. Choose real absolute paths and
obtain the adapter-provided descriptor.

```python
a = room("join", {"client": "copilot", "purpose": "candidate work", "name": "shared-checkout"})
b = room("join", {"client": "copilot", "purpose": "second task", "roomId": a["roomId"]})
scope = [{"kind": "path", "identity": r"C:\Work\checkout", "mode": "exclusive"}]

claim = room("claim", {"sessionId": a["sessionId"], "roomId": a["roomId"], "resources": scope})
# Perform only the declared edits; retaining this claim through the build is supported.

barrier = room("cohort", {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "expectedGeneration": 0,
    "candidate": "base-and-diff-fingerprint",
    "cohort": [a["sessionId"], b["sessionId"]], "resources": scope,
})
ready_a = {"sessionId": a["sessionId"], "roomId": a["roomId"],
           "generation": barrier["generation"], "candidate": barrier["candidate"]}
ready_b = {**ready_a, "sessionId": b["sessionId"]}
room("ready", ready_a)
room("ready", ready_b)
room("freeze", ready_a)

build_script = pathlib.Path(r"C:\TrustedScripts\build-candidate.py")
room("run", {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "scriptPath": str(build_script),
    "sha256": hashlib.sha256(build_script.read_bytes()).hexdigest().upper(),
    "parameters": {}, "effects": "offline", "resources": scope,
    "barrierGeneration": barrier["generation"], "candidate": barrier["candidate"],
})
room("thaw", ready_a)
room("release", {"sessionId": a["sessionId"], "claimId": claim["id"]})
```

Runtime flow with a separately delivered domain adapter:

```python
adapter = pathlib.Path("trusted_adapter.py").resolve()
room("register-adapter", {
    "sessionId": a["sessionId"], "name": "local", "path": str(adapter),
    "sha256": hashlib.sha256(adapter.read_bytes()).hexdigest().upper(),
})
# Resolve is domain-owned, not a core action. The resulting descriptor must match
# the fixed contract and start with empty state.
descriptor = json.loads(pathlib.Path("resolved-target.json").read_text(encoding="utf-8"))
registered = room("register-target", {"sessionId": a["sessionId"], "target": descriptor})
queued = room("request", {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "targetId": registered["id"],
    "fingerprint": registered["fingerprint"], "descriptorGeneration": registered["generation"],
    "purpose": "protected verification",
})
active = room("activate", {"sessionId": a["sessionId"], "requestId": queued["id"]})
# Preserve active["use"]["id"] throughout the protected verification window.
room("release-use", {"sessionId": a["sessionId"], "useId": active["use"]["id"]})
room("leave", {"sessionId": a["sessionId"]})
```

If activation returns Queue/Busy, finish independent unclaimed work and retry the
**same** request when ownership permits, or cancel it. Never invoke the adapter
manually to bypass the queue.

## Claims and barriers

Claims are global across rooms. Shared/shared is compatible; either exclusive
mode conflicts. Input `kind` and `mode` enums are normalized to lowercase before
conflict checking and persistence; casing never changes exclusivity. A path always denotes itself **and its descendants**. Paths are
case-insensitive and boundary-aware; `C:\Work\A` does not overlap `C:\Work\AB`.
Keys use full NFC-normalized case-insensitive identities, without lossy filename
substitution. Two different resource kinds do not overlap; domains must choose
one consistent kind/identity for a physical resource.

Paths must be absolute and local. Reject traversal, symbolic links/reparse points,
hard-linked files, and network filesystems. On Windows, also reject alternate
streams, wildcards, trailing dots/spaces, reserved device components, UNC/device
paths and removable drives. Existing path ancestors are checked. Cooperation and
trusted ACLs remain necessary: this is not a defense against a local administrator
changing paths.
Declared path resources cannot contain or overlap the coordinator's own state root.
Existing directory scopes are scanned for reparse/hard-link descendants, and fail
closed if any descendant cannot be inspected. This can be expensive for large
checkouts; declare narrower scopes rather than bypassing alias checks. Do not create
aliases or change mounts while a scope is held.

Even same-session overlapping exclusive claims normally conflict. For ordinary
`run`, release overlapping manual claims first. For a combined candidate, the
barrier provides an explicit exception: its exact owner/generation/candidate may
run using that freeze reservation and the paused participant claims described below.
Active-runtime reservations are exempted only for an exclusive lifecycle/runtime
mutation that has drained all users.

`cohort` snapshots a specific participant list, candidate identity and scopes.
When `room.barrier` is null, any current member can submit `cohort` with the exact
`expectedGeneration` to atomically become `room.owner`, create the candidate and
advance the generation. This is the sole captain handoff: no unfinished/faulted
operation may exist, and no prepared turn for that room may remain. Another
member can lead the next candidate while the previous captain remains a member,
or after that captain has explicitly left. Immutable room identity/records remain.

Once a candidate exists, only its current captain may replace it while unfrozen;
readiness, freeze and thaw retain their existing exact-owner/version checks.
Another member cannot take over even an unready candidate. Finish/thaw it and
release its prepared turn before acquiring the next captaincy. Concurrent
boundary requests with the same expected generation admit only one candidate;
the loser must inspect and respect that candidate, not retry as an owner override.

Every member must independently acknowledge the current generation/candidate.
An exclusive claim touching a candidate clears all readiness and marks it dirty;
define a new cohort generation after completing edits. A participant may retain
its existing manual edit claims: `ready` promises no further editing until `unready`
before freeze, or until `thaw` after freeze. Recompute the candidate and define a
new cohort generation if edits resume.

Only manual claims **from this room**, owned by the explicit cohort, with **every
resource entirely contained** in the candidate scopes, are eligible. Split a claim
that mixes inside/outside scopes; broader parent claims are not silently waived.
Runtime claims, other rooms' claims and nonparticipants' claims still conflict.
For a prepared candidate, only its exact versioned turn additionally exempts
the associated turn reservation; no unrelated runtime or room is exempt.

Once all participants are ready, `freeze` atomically records their eligible claim
IDs in `barrier.participantClaimIds`, sets each claim's `suspendedBy` to the exact
room/generation/freeze ID, and acquires the exclusive candidate reservation.
Suspension means **no participant writes or claim release**, not lost ownership.
Only the barrier owner's explicitly declared combined `run` and prepared runtime
transitions can use those scopes.
Late membership cannot change the cohort or access the reservation. Shared reads
of a frozen scope also wait. Unrelated scopes remain available.

An interrupted build retains the freeze **and** suspended participant claims until
owned recovery succeeds. `thaw` then clears suspension, restores the original
claims to their owners and removes only the freeze reservation. A frozen operation
must complete or reconcile before thaw. Owners release their restored claims when
they actually finish.

## Immutable records and messages

Use the helper, not a parallel hand-edited metadata tree beneath the state root:

```python
room("record", {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "key": "checkout:library",
    "value": {"checkout": r"C:\Work\library", "base": "resolved-base-commit", "selection": "workflow-owned"},
})
room("message", {
    "sessionId": b["sessionId"], "roomId": a["roomId"], "text": "Combined verification completed",
    "data": {"outcome": "passed", "candidate": "base-and-diff-fingerprint",
             "artifact": r"C:\Evidence\result.txt"},
})
status = room("inspect")
records = [item for item in status["state"]["records"] if item["roomId"] == a["roomId"]]
messages = [item for item in status["state"]["messages"] if item["roomId"] == a["roomId"]]
```

`record.key` is unique within the room using full NFC-normalized case-insensitive
identity; no lossy filenames. Neither the creator nor another participant may
replace/delete a record. Use a new explicitly versioned key for a new immutable
fact. `value` is an opaque object: the workflow owns checkout/base/repository
meaning and validation. Recording metadata does not acquire a checkout claim or
perform any domain operation.

`message.text` is a nonempty string (maximum 4096 characters); `data` defaults to
an empty object. Messages have unique UUIDs, owner, room and creation time and are
transactionally appended without overwriting another participant's note. Inspect
returns both ledgers. No message or payload is executed by the core. Keep secrets,
large logs and binaries out; record artifact references instead. No automatic
metadata/message pruning or live legacy migration is provided.

## Runtime scheduling

This version enforces **one active target** and **one heavy mutation** per root.
That generic capacity constraint is not product-specific. Do not claim exclusion
against other roots, nonparticipants or unregistered resources.

Requests are strictly FIFO, including same-target requests. A head request matching
the active descriptor can share the existing runtime generation while other uses
remain. A queued different target prevents later same-target users from jumping it.
Switching waits for every current use; there is no forced time slice.

Before any transition or reuse, inspect every registered descriptor through its
pinned adapter. Unknown or unexpected running inventory faults the operation.
Stop the old target, persist the returned state, inspect it and the full inventory,
then start the next. Persist even partial results before granting any use. Running
targets retain their physical claims until stopped. Successful run mutations
advance runtime generation; ordinary shared reuse does not.

There is no daemon: transitions progress only when called. Releasing the last use
leaves a warm target. Runtime claims have `owner:null` and `targetId`: they belong
to the target, not its first activator. `runtime.participants` records sessions
that successfully used/adopted this runtime. A participant may release its use and
leave while another nondeparted participant remains. Any remaining participant
can `park` after **all** uses drain; the last participant's `leave` parks first.
An unrelated member cannot park. Each park takes a fresh operation lease; a faulted
or interrupted operation still requires its exact recorded owner to recover.
`runtime.owner` identifies the last transition controller, not a lifetime lock.
Successful stopped inspection sets `runtime.owned:false`; a later manual restart
cannot inherit the old permission to Stop or reuse.

A queued requester may switch once users drain. Membership alone never blocks
a switch. Prepared turns below hold an explicit FIFO slot across several calls.

## Prepared candidate turns

Use this when frozen source/output scopes overlap runtime resources. Do **not**
freeze then queue (deadlock), start an old artifact to obtain a slot, thaw between
build and verification, or omit a physical resource to avoid conflict.

1. Finish edits, define the exact clean cohort/candidate, and release the requesting
   owner's manual claims. Other cohort members may retain contained claims, but
   must finish edits before promising readiness. Queue with `barrierGeneration`
   and `candidate`; hold no manual/freeze/use/turn while waiting.
2. At FIFO head, call `prepare`. It takes a heavy-operation lease, requires zero
   runtime uses, exclusively reserves the union of candidate and target scopes,
   inventories and stops the old target, then commits a durable prepared turn.
   It never invokes Start, so stopped content blockers/missing build artifacts
   do not prevent preparation. Unknown/unexpected running identity still blocks.
3. Gather `ready` and `freeze` under that turn. Freeze suspends eligible participant
   claims. The only overlap exemptions are this exact room/generation/candidate.
   No other candidate or runtime may use the reservation.
4. `run` offline build/deploy steps under the frozen barrier **and** current turn
   token. Declare all effects; scopes must be entirely contained in the reserved
   union. Resolve a descriptor after build and, if changed, `supersede-target`.
5. `activate` with the current turn token. This uses the registered generation,
   requires the exact freeze, and grants one verification use. Keep that use and
   freeze across verification. Other FIFO requests may queue but cannot activate.
6. `release-use`, `park`, `thaw`, then `release-turn`. Parking comes **before**
   restoring write claims. Keep the latest turn generation after supersession.

```python
queued = room("request", {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "targetId": registered["id"],
    "fingerprint": registered["fingerprint"], "descriptorGeneration": registered["generation"],
    "purpose": "build and verify exact candidate",
    "barrierGeneration": barrier["generation"], "candidate": barrier["candidate"],
})
prepared = room("prepare", {"sessionId": a["sessionId"], "requestId": queued["id"]})
turn = prepared["turn"]
token = {"sessionId": a["sessionId"], "turnId": turn["id"], "turnGeneration": turn["generation"]}
frozen = {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "generation": barrier["generation"],
    "candidate": barrier["candidate"], "turnId": turn["id"], "turnGeneration": turn["generation"],
}
room("ready", frozen)
# Each other cohort member independently calls ready with its own session ID.
room("freeze", frozen)
room("run", {
    "sessionId": a["sessionId"], "roomId": a["roomId"], "scriptPath": str(build_script),
    "sha256": hashlib.sha256(build_script.read_bytes()).hexdigest().upper(), "parameters": {},
    "effects": "offline", "resources": scope,
    "barrierGeneration": barrier["generation"], "candidate": barrier["candidate"],
    "turnId": turn["id"], "turnGeneration": turn["generation"],
})
# If rebuilt configuration/fingerprint changed, resolve `replacement` via the domain.
updated = room("supersede-target", {
    "sessionId": a["sessionId"], "targetId": registered["id"], "fingerprint": registered["fingerprint"],
    "descriptorGeneration": registered["generation"], "target": replacement,
    "turnId": turn["id"], "turnGeneration": turn["generation"],
})
registered = updated["target"]
token["turnGeneration"] = updated["turn"]["generation"]
frozen["turnGeneration"] = updated["turn"]["generation"]
active = room("activate", token)
# Verify the frozen candidate while retaining active["use"]["id"].
room("release-use", {"sessionId": a["sessionId"], "useId": active["use"]["id"]})
park = {**token, "runtimeGeneration": active["runtime"]["generation"]}
room("park", park)
room("thaw", frozen)
room("release-turn", token)
```

`turn` has `id`, `generation`, `owner`, `roomId`, `barrierGeneration`, `candidate`,
`targetId`, `fingerprint`, `descriptorGeneration`, exclusive `resources`, `claimId`
and `activated`. Prepare consumes the FIFO request and returns generation 1 of a
unique turn. Supersession increments its generation atomically; stale tokens fail.
One completed activation is allowed per turn. A successful adoption during recovery
also consumes that activation. The original candidate cannot be redefined until
the turn is released. No timeout expires a prepared turn.

Cancel a still-queued request with `cancel`. Cancel an acquired but unfrozen,
stopped turn with `release-turn`. A frozen turn must thaw first. Failed/crashed
work retains the operation, turn, freeze and suspended claims until exact-owner
recovery; successful recovery preserves the turn/freeze for retry or cancellation.
Prepared turns serialize heavy mutations as well as runtime access; unrelated
unclaimed work and nonoverlapping manual claims remain possible.

## Stopped descriptor supersession

`supersede-target` replaces **one** immutable descriptor generation, using the
expected old `targetId`, `fingerprint`, `descriptorGeneration` and a complete new
`target` with empty initial `state`. The same target ID is supported for repeated
rebuilds. A distinct unused replacement ID is also supported. A changed adapter
requires a new explicitly pinned registry name/path; restore the old pin if needed
to establish its stopped proof first.

Require no active runtime/uses, no outstanding request referencing the old
generation, and exclusive old physical resources. Outside a prepared turn,
any queue takes priority. Inside an unactivated frozen turn, its owner may refresh
only that turn's descriptor; unrelated queued targets do not lose their FIFO place.
Replacement resources must be the exact canonical identity/mode set, not guessed
or reduced scopes. A different physical topology requires a separately reviewed
inventory-registration workflow, not this API.

Inventory the old descriptor and every other active descriptor as stopped, then
independently inspect the replacement as stopped. Content blockers are acceptable
for this proof, but still prohibit future Start. Commit old retirement and new
registration **together**, preserve `history[].retired`, and exclude only the
retired generation from subsequent active inventory. There is no standalone retire
action that could leave physical resources unrepresented. Failed replacement
inspection keeps `operation.pendingDescriptor` and its state in recovery inventory;
it grants no launch ownership, and must prove stopped before recovery can finish.

### Additive scope expansion

A stopped descriptor whose resource set is incomplete (for example, a legacy
generation that predates a required resource) can be widened with the same
`supersede-target` action by adding `confirm: "EXPAND_STOPPED"`. Any other `confirm`
value is rejected as invalid, and an unconfirmed request keeps exact scope equality.

Expansion is accepted only when all of these hold:

- the new `targetId` equals the old one;
- every existing `(kind, identity, mode)` tuple is retained unchanged, with no
  omission, identity rebind or mode change;
- at least one tuple is added;
- there is no prepared turn (exact supersession still supports prepared turns);
- the existing begin gates apply: no queued work, runtime users, outstanding request
  or other operation.

The whole union of old and new resources is claimed exclusively before any adapter
inspection. Manual claims, frozen-turn conflicts and queued ownership therefore block
it. Unfrozen readiness is invalidated for the union. Inspection proves every active
target stopped, including the pending replacement. No Start or Stop is issued.

On success the old generation moves to history as `descriptor-expansion` with its
`retired` record and `addedResources`, and the new descriptor generation is returned.
On failure the old active descriptor, `operation.pendingDescriptor` and the whole union
claim remain for explicit recovery. Recovery must prove the pending inventory stopped
before completing; the old target is not replaced without that proof.

### Recover a stopped registry from an unusable adapter pin

Use `rebind-adapter` only when the old pins cannot prove quiescence. Register a
reviewed replacement under a distinct name without altering the old files or
registrations. Provide exactly one of `oldAdapter` (one exact registered `name` and
`sha256`) or `oldAdapters` (a nonempty array of distinct exact registrations, compared
case-insensitively). `newAdapter` contains the exact registered `name` and `sha256`
and must differ from every old name. Each entry in `targets` contains the old
`targetId`, `fingerprint` and `descriptorGeneration`, plus a complete replacement
`target` with empty `state`, the same ID and exact canonical resource list in the
same order. Every target owned by a selected old pin must appear exactly once, each
selected pin must own at least one target, and no target outside the selection may
appear. Malformed, duplicate, incomplete or unselected mappings fail before any
adapter call. The replacement must implement the read-only `InspectRebind` adapter
contract.

Require the same boot, no unfinished operation, no runtime/use/turn, no claims
overlapping the migrated resources and no queue entries for migrated targets.
The operation lock serializes lifecycle work. The core asks the replacement pin
to inspect each migrated target against its original descriptor without loading
any old pin. All other targets must pass normal `Inspect` on their own pins. All
results must be stopped and unblocked. Any failure or coordinator revision change
aborts before commit. Success advances every migrated generation in one commit,
archives each old descriptor, and writes one `adapter-rebind` history record per
target with that target's actual old registration. It leaves unrelated requests and
claims unchanged. This action cannot stop an unmanaged runtime or change its topology.

## Run scripts

`run` invokes an explicit caller-supplied Python `.py` script with a checked SHA256.
The `parameters` object is sent as JSON on standard input; output lines are returned
as `data.output`. It never executes shell command text recovered from a room. Declare every
physical side effect. It is not a sandbox and cannot infer omitted resource effects.
The entire declared claim set is acquired atomically or the call immediately fails.
No claims or operation record are added on claim failure; it never waits with a
partial claim set. Claims cannot be acquired by a session with a pending runtime
request, and queueing is forbidden while holding manual/freeze claims or uses.

- `effects:"offline"`: normal build/restore/artifact work. Active runtime claims
  are not exempt; writes to loaded outputs therefore block.
- `effects:"runtime"`: also require `targetId`, `fingerprint`,
  `descriptorGeneration`, `runtimeGeneration`. The target must be active, no uses
  may remain (including the caller's), and no runtime request may be queued.
  All target resources are added in exclusive mode; successful completion advances
  runtime generation.
- For a combined candidate, supply `barrierGeneration` and `candidate` for the
  caller's own frozen room. Retained cohort edit claims must be eligible and
  explicitly suspended by that same freeze; ordinary caller-owned claims are
  not implicitly exempt.
- During a prepared turn, also supply its current `turnId`, `turnGeneration`.
  The caller must own that turn and its frozen candidate. Offline build/deploy
  cannot touch resources outside the turn's complete reservation. Runtime effects
  may use the already-held slot ahead of later requests, but still require zero
  uses and exact active descriptor/runtime generations.

Scripts must run synchronously, wait for children, return nonzero on failure, and
not detach child work, return credentials, or launch a second runtime. Nonzero
exit codes cause failure. Standard output is captured as strings in `data.output`;
it is not stored in the durable journal. The script itself is not automatically
retried. A thrown/failed/interrupted script retains the
operation and its claims for explicit reconciliation. A generic engine cannot
prove arbitrary script effects or descendants quiescent: recovery requires
the operator's exact-resource attestation **in addition to** adapter inspection.
Use a domain-specific wrapper with inspectable ownership for such work.

## Validation

No external test packages are required:

```text
python -m unittest discover -s .\tests -p test_resource_room.py -v
```

The suite creates unique disposable state, uses fake adapters/scripts rather than
real services, and launches competing Python processes for claims and wait-and-claim.
It covers schema-2 snapshot integrity, candidate prepare/freeze/run/thaw, runtime
activation/parking, partial-start recovery and stopped descriptor supersession.
Do not replace fake fixtures with live runtime adapters.
