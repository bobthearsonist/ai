---
name: resource-coordination
description: Coordinate concurrent host-local sessions, shared checkouts, physical resource claims, wait-and-claim, runtime handoffs, FIFO requests, and ready/freeze barriers. Use before advising on, planning, or performing start, stop, use, rebuild, or deploy actions involving a local application stack or its loaded artifacts that may be shared with other sessions, even when coordination is not mentioned; also use for competing builds, mutations, or recovery of an interrupted owned operation. For plan-only or answer-only requests about these shared-runtime actions, load this skill without executing coordinator commands. Read-only source inspection does not require coordination. Provides a cross-platform Python coordinator with pinned domain adapters.
---

# Resource coordination

Use the standard-library Python CLI at `scripts/resource_room.py` (Python 3.10+).
Pass every action as a JSON request; do not improvise filesystem locking or edit
coordinator state yourself. Adapters use the same Python/JSON subprocess contract.
The coordinator does not require PowerShell. Adapters define their own platform
and dependency requirements.

For plan-only or answer-only requests, load this guidance without executing
coordinator or lifecycle commands. Begin with a **Coordination safety** preface.
Copy the applicable safety sentences below verbatim, then add task-specific
steps. Keep the runtime and its owner explicit; do not shorten these conditions
to "it" or descriptor-only shorthand.

- **Always:** Never stop or kill another session's runtime to make room. Request
  FIFO runtime access instead.
- **Already-running runtime:** Use the same target and its exact registered
  descriptor (`id`, `fingerprint`, generation). Keep the activated use throughout
  testing and release it afterwards.

1. Resolve **one shared absolute root**, default `$HOME\.resource-rooms`. Pass it
   explicitly across tool calls and elevation; a different root does not coordinate
   with this one. Keep live state off repositories and synchronized/network storage.
2. Inspect, then join. Preserve the returned session/room IDs across commands.
   Pass your harness session ID as `clientSession` when one is available (Claude
   Code exposes `CLAUDE_CODE_SESSION_ID`), so guards outside the coordinator can
   recognize the access your session holds.
   Use `join.roomKey` for atomic create-or-join of a canonical execution room;
   display `name` alone deliberately creates distinct rooms.    A session does not end when the CLI process exits.
3. Declare actual physical resources, not just room labels. Acquire edit claims
   before edits and release only your own claims. Path claims include their subtree.
   `wait-claim` is only for manual edit claims, never for queueing runtime use,
   startup, or loaded-artifact rebuild/deploy. Use the runtime FIFO in steps 4-6
   for those operations.
   If a manual claim is temporarily unavailable, use `wait-claim` with the same
   resources instead of stopping and relying on someone to notify you; it atomically
   acquires the claim when available. Bound the wait with `timeoutMs`, and after a
   timeout preserve the task and retry when appropriate. It is not FIFO; coordinate
   edit order explicitly when multiple waiting editors require a guaranteed order.
   Store immutable workflow metadata with `record`; post participant/result notes
   with `message`. Keep domain fields in their opaque payloads.
4. For an offline candidate, define a versioned cohort, gather readiness, freeze,
   run, then thaw. At a quiescent candidate boundary, any current member may
   atomically acquire captaincy by defining `cohort` with the current room
   generation. An existing candidate/turn or unfinished operation cannot be
   transferred. If runtime resources overlap, **first** queue a candidate-bound
   `request` and acquire its FIFO `prepare` turn without starting artifacts.
   Then ready/freeze, build/deploy, optionally `supersede-target` the stopped
   descriptor, activate that turn, and verify under its use. Release the use,
   park, thaw, then `release-turn`. Keep the freeze through verification.
   Readiness promises an edit pause; freeze suspends retained participant claims.
   Late joiners wait for the next cohort; new edits invalidate readiness.
5. For runtime use, register trusted pinned adapters and resolved descriptors,
   `request`, then `activate` when first in FIFO. If the target is already
   running, use its exact descriptor (`id`, `fingerprint`, and generation);
   do not register a duplicate to bypass the queue. Never stop or displace
   another session's runtime to make room; request access, wait, or coordinate
   with its owner. Keep the returned use through the entire test/reproduction
   window; `release-use` when finished. Never hold manual or frozen claims while
   queueing runtime access. A prepared turn is the explicit versioned exception
   **after** FIFO acquisition, never permission to queue while frozen.
6. Use `run` for heavy mutations with an explicit local script, SHA256, and complete
   atomic resource declaration. Runtime mutations require zero shared users.
   Release your uses/claims/turns and cancel your pending request before `leave`.
   Runtime reservations belong to the target; any successful current participant
   can park after users drain. The last participant's departure parks automatically.
   Retire rebuilt descriptors only through verified stopped `supersede-target`.
   An incomplete stopped legacy descriptor may be widened only with
   `confirm: "EXPAND_STOPPED"`, which is additive-only and same-ID.
7. On uncertainty, stop. Read ownership and follow explicit recovery; never steal
   by age, delete locks/state, kill by process name, or start another target after
   an incomplete stop/start.

Read [room-protocol.md](references/room-protocol.md) for exact action schemas,
examples, fairness and execution restrictions.
Read [adapter-contract.md](references/adapter-contract.md) before integrating a
domain adapter.
Read [recovery.md](references/recovery.md) when ownership, inventory, boot identity,
adapter pins, or state validation fails.

## Domain composition

Load the domain skill appropriate to the task separately. Domain skills own
resource policy, target descriptors, and their lifecycle adapters. Register an
adapter from a trusted absolute path using the adapter contract; it does not
need to live inside this skill. Verify capabilities against the installed tool;
an in-flight source change is not an installed capability.

The engine knows no product lifecycle commands or workflow policy. Profiles and
consumers own descriptor resolution, candidate identity, declared effects and
domain-specific evidence. This is cooperative coordination, **not** an OS security boundary,
distributed scheduler, daemon, or automatic legacy-room migration.
