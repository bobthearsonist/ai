# Recovery and ownership

## Contents

- [First response](#first-response)
- [Exact recovery requests](#exact-recovery-requests)
- [Fault cases](#fault-cases)
- [Limits and migration](#limits-and-migration)

## First response

1. `inspect` the same absolute root. Preserve the fault, runtime claims, uses and
   current operation's `id`, `generation`, `owner`, `phase`, results and error.
2. Resume **the recorded owning session ID**. Normal release, cancellation and
   recovery never steal another session's ownership. If the session ID is lost,
   recover it from inspection with an operator; do not invent a replacement.
3. Have every runtime-use owner release its own use. Release/cancel are permitted
   across a boot mismatch; new work is not. Membership never expires by age.
4. Reconcile exact identities through the trusted adapter or operator. Do not
   remove files, change timestamps, or bypass pins to create an apparently empty
   slot.
5. Submit an explicit versioned recovery request. Retry pending activation only
   after recovery succeeds.

If every session departed before a reboot, there is no recorded live owner to
resume. Only when inspection shows no live sessions, claims, pending requests,
operation, frozen barrier, runtime target, ownership, participants, uses or
prepared turn, create a recovery-only session:

```json
{"client":"copilot","purpose":"reconcile idle root after reboot","name":"boot recovery","recoverBoot":true}
```

Pass this to `join` without `sessionId`, `roomId` or `roomKey`. The atomic gate
refuses it if any owner or reservation remains. The returned `recoveryOnly:true`
does **not** clear the boot mismatch or authorize work. Use that new session ID
with `recover`, `confirm:"RECONCILE"`, `mode:"verify-stopped"` and the inspected
`runtimeGeneration`. Recovery still inspects every registered target and fails
if any is running or unknown. Do not equate an idle ledger with stopped native
resources, or delete the root to bypass failed inventory.

The OS releases the **file handle** if the controller dies, but the snapshot's
operation and claims remain authoritative indefinitely. `inspect.recoveryRequired`
is true while any operation is present, including an executing one; this is a
conservative signal, not proof it crashed. `recover` also acquires the long-operation
exclusive file handle, so it cannot run while the original controller is still
executing. No heartbeat, PID absence or old timestamp grants permission.

## Exact recovery requests

For an existing operation, every mode requires:

```json
{
  "sessionId":"<operation.owner>",
  "confirm":"RECONCILE",
  "operationId":"<operation.id>",
  "operationGeneration":12,
  "mode":"verify-stopped"
}
```

Without an operation (for example, a boot mismatch), supply the current
`runtimeGeneration` instead of the operation ID/generation. If a runtime target
is recorded, use a nondeparted successful runtime participant session. Runtime
reservations are target-owned; the original activator may already have left.
An existing operation is different: **only its exact recorded owner** may recover.
While a prepared turn exists, that owner must also own the turn; no other session
can reconcile around its candidate reservation.
Recovery associates the exact retained turn/barrier even when the prior activation
completed and `operation` is null (including after reboot). Only that freeze and
its suspended participant claims are exempted; recovery preserves their ownership
and records the barrier association for any subsequent recovery attempt.

| Mode | Required proof / behavior |
|---|---|
| `verify-stopped` | Read-only Inspect of **every active** registered target and any unresolved replacement must return stopped; content blockers are acceptable quiescence proof, never Start permission |
| `stop-owned` | Explicitly authorize scoped Stop only for established runtime/operation-owned targets with nonempty identity state; merely requested/inspected targets are never owned; all unowned/unknown other inventory blocks before any Stop; inspect all targets stopped afterwards |
| `adopt` | Also pass `targetId`, `fingerprint`, `descriptorGeneration`; exactly that target must inspect running and ready without blockers, all others stopped; obtain its physical claims before recording adoption |
| `release-unstarted-run` | Same boot and exact owner/operation token. Only a faulted `run` whose first `Inspect` failed before any result, with no runtime, launch attempt, or prepared reservation |

`release-unstarted-run` only archives the fault and releases its operation claim.
It does not invoke adapters, fix or replace their pins, or prove native resources
are stopped. Pending activation still requires fresh inventory of all targets.

Recovery never invokes Start. The inventory-based modes persist every adapter
result and use a **new** operation token/generation for their own work. A failed recovery retains ownership;
inspect again to obtain its new ID/generation for the next recovery attempt.
Prior established ownership, reservations and barrier association survive repeated
recovery attempts. `operation.ownedTargets` is authoritative for an unfinished
operation; `previousTarget` and `requestedTarget` are diagnostic pointers, not
permission to stop anything.

`launchAttempts` records durable Start invocation intent and whether a result was
returned. Intent alone is not established ownership. A valid returned Start result
with owned runtime state can establish partial-attempt ownership; a completed
activation or **successful** explicit adoption establishes runtime ownership.
Inventory-only discovery and failed adoption never do. Every stopped inspection revokes that target's operation ownership and sets the
corresponding `runtime.owned:false`, even with content blockers or a failed Stop
result. The revocation persists across successful unrelated offline operations;
a later manual restart cannot inherit stale shutdown or reuse authority.

If the controller/adapter dies before returning owned launch identities, later
Inspect discovery does not retroactively grant shutdown permission. Reconcile exact
resources outside the helper and use `verify-stopped`, or explicitly adopt a
ready, fully verified target. Never turn a launch-intent record into a force-stop.

For a failed/interrupted generic `run` not eligible for `release-unstarted-run`,
additionally supply:

```json
{"resourcesReconciled":true}
```

This is the operator's explicit assertion that the script's exact child processes
and all declared physical effects have been checked/quiesced. Do not set it merely
because the controller PID is gone or time elapsed. The engine cannot discover
arbitrary script descendants; registered runtime inspection still must prove the
required stopped/adopted inventory. Scope this assurance to named resources, not
"kill all" cleanup.

For a prepared candidate, recovery keeps the exact `runtime.turn`, its claim,
frozen barrier and suspended participant claims. Failed Start can retry through
that same turn after reconciliation. Successful explicit adoption consumes its one
activation; release/park/thaw/release-turn rather than starting again. A failed
`prepare` retains its operation claims and pending FIFO request, not a fabricated
turn; recover first, then retry/cancel the request. A failed supersession preserves
`operation.pendingDescriptor` across repeated recovery attempts: its inspection
must independently prove stopped before any recovery mutation or completion. A failed
confirmed scope expansion likewise keeps the whole union claim and its pending
inventory until that proof succeeds.

Successful recovery:

- preserves sessions, room membership, immutable records/messages, manual claims,
  prepared turns, barriers (including suspended claims) and pending requests;
- removes only runtime/operation reservations covered by the reconciliation;
- advances runtime generation and reconciles boot identity;
- grants **no** runtime use automatically;
- retains the old operation and recovery events in history.

Owners then cancel/retry their pending requests/turns or thaw the recovered barrier
with its current turn token where applicable. Park an adopted prepared runtime
before thaw so participant writes cannot resume against loaded outputs.
Adoption does not erase the queue. It does not permit jumping a waiting target.

## Fault cases

| Symptom | Safe next action |
|---|---|
| Failed/partial Stop | Keep slot occupied/faulted; repair exact owned shutdown, then `stop-owned` or `verify-stopped`; never start B |
| Partial Start | Inspect persisted attempt identities; reconcile only that attempt; retain data; no automatic rollback to the previous target |
| Unknown/unexpected running target | Explicit adoption with matching descriptor, or operator-scoped shutdown followed by stopped proof |
| Adapter changed on disk | Restore the exact trusted pinned script to reconcile its runtime; new code requires a new registered name/path after safe parking. Several unusable pins migrate atomically through one `rebind-adapter` with `oldAdapters` |
| Controller died while run/transition active | Resume owner session and token; inspect exact resources; recover, never remove lock files |
| Long-held use/manual claim | Ask/resume that owner to release; no timeout, force release, or session GC |
| Changed descriptor/config/composition | Park/reconcile; `supersede-target` the unreferenced stopped generation with complete equal physical resources; retain old descriptor in history. For an incomplete stopped legacy generation, `supersede-target` with `confirm: "EXPAND_STOPPED"` may only add tuples |
| Known owned runtime not ready/content drift | Reject reuse/Start; authorized park can Stop established identities without readiness; stopped content blockers do not prevent cleanup |
| Prepared turn holder disappeared | Resume its exact owner; inspect/recover any operation, park if needed, thaw, release-turn; never expire the turn |
| Reboot | Resume live owners to release/reconcile; if every owner departed and the root is completely idle, use the explicit recovery-only join above, then inventory and reconcile before new work |
| Malformed/missing snapshot, wrong root/host, unsupported schema | Stop. Preserve evidence and recover the original root/valid known snapshot through operator-led review; no automatic reset/migration |
| Orphan `.pending` snapshot | Treat it as nonauthoritative; do not promote it over committed state merely because it is newer |
| Busy state lock | Retry normally; if an operation is hung, inspect exact controller/resources rather than deleting the lock |

There is deliberately no `force`, `expire`, `clear-all`, live registry replacement
or delete-owner action. Only explicit stopped supersession replaces a generation.
Recovery cannot repair arbitrary schema corruption because
it cannot safely establish ownership from malformed data. A separate reviewed
operator procedure is required, not speculative JSON editing by agents.

## Limits and migration

Only cooperating clients using the same root are covered. Registration is not
discovery of every process on the host. Adapters must detect unknown live resources.
The helper cannot establish identity from a PID alone or enforce omitted effects.
Sessions/claims/turns and the append-only snapshot history have no automatic garbage
collection. Captaincy may change only through a generation-checked `cohort` at an
idle candidate boundary, with no existing barrier or same-room prepared turn.
This does not transfer an existing candidate, runtime use or unfinished operation,
and does not introduce a general job scheduler.

Schema 2 adds prepared turns, target-owned participant authority and durable
runtime ownership revocation; schema-1 roots fail closed, with no implicit upgrade.
Do not automatically migrate a live legacy room. Quiesce all legacy participants
and their runtime resources, obtain explicit operator approval, select the shared
root, register/inspect complete descriptors, and start new memberships. Keep old
state as evidence until the operator approves a separate cleanup. Never mix
legacy writers and coordinator writers while claiming exclusivity.
