# Adapter contract

Register a trusted absolute local Python `.py` adapter with a caller-supplied
SHA256:

```json
{"sessionId":"<own-session>","name":"local","path":"C:\\TrustedAdapters\\local_adapter.py","sha256":"<64-hex-digits>"}
```

Adapter names cannot be overwritten, even by their original owner. Pin checks occur
on registration, descriptor registration and **every invocation**. A changed pin
blocks, never silently replaces code. Deliver changed adapters under a new name/path
after the prior runtime is safely parked. The registry selects the path; no target
or member record can supply an alternative command.

Only Python `.py` adapters are accepted and executed, using the coordinator's
Python interpreter. Adapters can ship independently of the coordinator.

An old adapter registration is not automatically converted. Park all runtimes
with the old release before an upgrade that changes adapter language or
fingerprints. Existing non-Python registrations remain readable historical
evidence but block lifecycle operations; do not rewrite their pins, descriptors
or state. Reconcile legacy inventory explicitly before using a new coordination
root, and move all participating clients together. Never use parallel roots to
bypass reservations.

## Invocation

An adapter receives one UTF-8 JSON object on standard input and writes exactly
one UTF-8 JSON result to standard output. Set the Python CLI streams to UTF-8
explicitly; a harness's console encoding must not change the wire format:

```json
{"action":"Inspect","target":{"id":"local-target-v1","fingerprint":"...","adapter":"local","resources":[{"kind":"key","identity":"listener:localhost:45001","mode":"exclusive"}],"config":{},"state":{}}}
```

`target` has the following core fields; internal descriptor generation is not
passed:

```json
{
  "id":"local-target-v1",
  "fingerprint":"resolved-composition-fingerprint",
  "adapter":"local",
  "resources":[
    {"kind":"path","identity":"C:\\Work\\target\\output","mode":"shared"},
    {"kind":"key","identity":"listener:localhost:45001","mode":"exclusive"}
  ],
  "config":{},
  "state":{}
}
```

`config` is domain-owned structured configuration, not shell command text.
`state` starts empty at registration and subsequently contains the **last persisted
adapter result state**. Return exact process identities (PID plus creation time and
image/root), container IDs and other non-secret ownership evidence there.
Each descriptor generation and fingerprint is immutable. Use `supersede-target`
after verified parking (or within a stopped prepared candidate turn) for changed
composition, including repeated generations of the **same target ID**. The action
preserves the old descriptor in history and atomically replaces active inventory.
A request must match both fingerprint and `generation` returned by registration
or supersession. Resource identities and modes must remain exactly covered, with one
explicit exception: a stopped descriptor may be widened by `supersede-target` only
with `confirm: "EXPAND_STOPPED"`. That request keeps the same target ID, preserves
every existing identity/mode tuple unchanged, and adds at least one new tuple. Without
that confirmation the action cannot silently move, drop or add physical resources.

Normal lifecycle actions called by the core are **Inspect**, **Start**, **Stop**. A domain
adapter may separately expose **Resolve** for its consumer to produce a descriptor;
the coordinator never invokes Resolve.

An adapter may opt into stopped pin recovery by implementing **InspectRebind**.
The request is exactly `{"action":"InspectRebind","originalTarget":{...},"target":{...}}`,
carrying both complete adapter-facing descriptors. The replacement adapter must
validate the old fingerprint and its original physical scope, reject changes other
than the reviewed pin/dependency transition, and independently inventory that
scope as stopped with no blockers or unresolved ownership. This action is
read-only and must never Start, Stop, adopt, or edit the old pin. A failed
inspection leaves the coordinator ledger unchanged.

Return exactly one JSON object:

```json
{"status":"stopped","ready":false,"state":{},"blockers":[]}
```

Only that JSON result may appear on standard output. Do not write logs, banners or
diagnostics to standard output. Return a nonzero process exit code on hard errors;
the coordinator persists the operation fault and requires explicit recovery.

## Required behavior

- **Inspect** must be read-only and inventory the real world, not merely echo
  recorded health. Detect unowned live resources, unknown identities, unexpected
  listeners and overlapping deployment ownership within the domain. Report
  `unknown` or blockers instead of inferring stopped from an absent record.
- **Start** may act only on the resolved target. Wait for readiness or return an
  explicit partial/unknown result. If startup launches anything before failure,
  return `unknown` **with its identities** rather than throwing and losing them.
  The generic core cannot persist identities it was never given.
  Returned partial-start state must identify resources actually owned by that
  attempt, not foreign resources merely discovered by preflight. A blocked preflight
  must not represent unowned observations as a partial launch.
- **Stop** must identity-check and stop only resources attributable to this
  target/attempt. Preserve persistent data, volumes, repositories and shared
  infrastructure. Never kill by name or use blanket cleanup.
- Return state that preserves identities still requiring reconciliation. A later
  inspection must not discard live partial-start identities.
- Unknown live ownership is not permission to stop it. Surface a blocker until
  the operator explicitly adopts or reconciles it.
- Capabilities must be checked read-only. An absent tool is unsupported, not
  permission to install, elevate, configure, or invoke a broad fallback.

Every Start/Stop result is persisted before further action. The core **always
calls Inspect after Start/Stop, including thrown mutations**. A failing mutation
still faults even if a subsequent inspection appears healthy/stopped; recovery
is explicit. Failed Stop never proceeds to Start of a different target.

### Identity versus readiness/content

Return these meanings consistently; a content hash mismatch alone is not unknown
process identity:

| Result | Core behavior |
|---|---|
| `running`, `ready:true`, no blockers | Eligible for established reuse or explicit adoption |
| `running`, `ready:false`, optional content/readiness blockers | Identity is established but use/Start is unsuitable; reject reuse, allow scoped Stop only with prior launch/adoption ownership |
| `stopped`, `ready:false`, optional content blockers | Quiescence is proved; accept for cleanup, offline rebuild and supersession, but blockers forbid Start |
| `unknown` | Identity/inventory ambiguity; block normal mutation regardless of recorded ownership |
| Unexpected `running` | Block normal mutation; inspection alone never establishes ownership |

Explicit `stop-owned` recovery can reconcile a returned partial-start identity
while its ordinary status remains unknown; it never adopts inventory-only
discoveries. A successful stopped observation revokes shutdown authority even if
content blockers remain. Preserve exact identity state when readiness/content
drifts so established cleanup remains possible.

The engine inventories **all active registered descriptors** before activation/reuse,
after stop, and after start. It cannot discover a domain or live target that none
of the registered adapters can see. Consumers must register a complete relevant
inventory and adapters must detect unregistered/legacy conflicts in their domain.
An empty or incomplete inventory is not evidence of machine-wide exclusivity.
Supersession inspects both the old descriptor and proposed replacement as stopped
under exclusive claims before one atomic registry swap. There is no retirement-only
action or inspection gap. If replacement inspection fails, its descriptor and
result state stay in the operation and must also prove stopped during recovery.
Retired generations remain historical, not competing active inventory entries.

## Trust boundary

This is a cooperative helper running trusted local code, not an authentication
service or command sandbox. Session IDs are ownership tokens for accidental
cross-session protection, not secrets or authorization against hostile users.
Trusted ACLs and a shared root are prerequisites. Hash checks detect changed
scripts, but a local administrator or an adapter's mutable imported dependencies
can bypass the protocol. Pin/distribute those dependencies through the domain's
own delivery procedure.

Keep credentials, connection strings, dashboard tokens, environment dumps and raw
secret-bearing command lines out of descriptors, state, blockers and output.
