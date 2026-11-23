"""Long-running, ownership-preserving resource-room operations."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any, Callable

from resource_room import (
    RoomError,
    RoomStore,
    add_claim,
    add_event,
    assert_claims_available,
    assert_idle_operation,
    assert_target_version,
    convert_resources,
    fail,
    get_adapter,
    get_claim_ids_for_cohort,
    get_owned_turn,
    get_room,
    get_session,
    get_target,
    get_turn_barrier,
    invalidate_readiness,
    new_descriptor,
    new_id,
    now,
    process_started,
    require_map,
    required,
    test_overlap,
    text,
)


def _transaction(store: RoomStore, action: Callable[[dict[str, Any]], Any], *, read_only: bool = False) -> Any:
    with store.transaction(read_only=read_only) as (state, box):
        box["result"] = action(state)
    return box.get("result")


def _operation_lock(store: RoomStore, action: str, owner: str) -> Any:
    from resource_room import _lock_file, _lock_owner

    lock, _ = _lock_file(store.root / "operation.lock", wait_ms=0)
    try:
        _lock_owner(lock, action, owner)
    except Exception:
        lock.close()
        raise
    return lock


def _assert_boot(store: RoomStore, state: dict[str, Any]) -> None:
    from resource_room import _same_boot

    if not _same_boot(state["boot"], store.boot):
        fail("Boot", "Boot identity changed. Explicit reconciliation is required before work resumes.", 5)


def _assert_park_participant(state: dict[str, Any], owner: str) -> None:
    runtime = state["runtime"]
    if runtime["targetId"] and owner not in runtime["participants"]:
        fail("Owner", "Only a successful participant in this runtime generation may park or reconcile it.", 4)


def _resources_contained(resources: list[dict[str, Any]], scopes: list[dict[str, Any]]) -> bool:
    for resource in resources:
        if not any(
            scope["kind"] == resource["kind"]
            and (
                scope["identity"].casefold() == resource["identity"].casefold()
                or (
                    resource["kind"] == "path"
                    and resource["identity"].casefold().startswith(
                        scope["identity"].rstrip("\\/").casefold() + os.sep.casefold()
                    )
                )
            )
            for scope in scopes
        ):
            return False
    return True


def _new_operation(
    state: dict[str, Any], owner: str, kind: str, target_id: str,
    claims: list[dict[str, Any]] | None = None, request_id: str = "",
) -> dict[str, Any]:
    state["operationGeneration"] += 1
    token = {"id": new_id(), "generation": state["operationGeneration"], "owner": owner}
    runtime = state["runtime"]
    state["operation"] = {
        "id": token["id"], "generation": token["generation"], "owner": owner, "kind": kind,
        "status": "running", "phase": "intent", "started": now(), "pid": __import__("os").getpid(),
        "processStarted": process_started(), "previousTarget": runtime["targetId"], "requestedTarget": target_id,
        "requestId": request_id, "claimIds": [claim["id"] for claim in (claims or [])],
        "results": [], "error": None, "barrier": None,
        "requiresResourceReconciliation": kind == "run",
        "ownedTargets": [runtime["targetId"]] if runtime["targetId"] and runtime["owned"] else [],
        "launchAttempts": [],
    }
    add_event(state, "intent", owner, kind)
    return token


def _assert_operation(state: dict[str, Any], token: dict[str, Any]) -> None:
    operation = state.get("operation")
    if (
        operation is None or operation["id"] != token["id"]
        or operation["generation"] != token["generation"]
        or operation["owner"] != token["owner"] or operation["status"] != "running"
    ):
        fail("Owner", "Operation token/generation/owner no longer matches.", 4)


def _set_phase(store: RoomStore, token: dict[str, Any], phase: str) -> None:
    def update(state: dict[str, Any]) -> None:
        _assert_operation(state, token)
        state["operation"]["phase"] = phase
        add_event(state, phase, token["owner"])

    _transaction(store, update)


def _complete(state: dict[str, Any], token: dict[str, Any]) -> None:
    _assert_operation(state, token)
    operation = state["operation"]
    state["claims"] = [claim for claim in state["claims"] if claim["id"] not in operation["claimIds"]]
    operation["status"] = "completed"
    operation["phase"] = "completed"
    add_event(state, "completed", token["owner"])
    state["history"].append(operation)
    state["operation"] = None


def _fault(store: RoomStore, token: dict[str, Any], error: BaseException) -> None:
    def update(state: dict[str, Any]) -> None:
        _assert_operation(state, token)
        state["operation"]["status"] = "faulted"
        state["operation"]["error"] = str(error)
        state["runtime"]["status"] = "faulted"
        add_event(state, "faulted", token["owner"], str(error))

    _transaction(store, update)


def _adapter_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"status", "ready", "state", "blockers"}:
        fail("Adapter", "An adapter must return exactly one structured result.", 5)
    if (
        value["status"] not in ("stopped", "running", "unknown")
        or not isinstance(value["ready"], bool)
        or not isinstance(value["state"], dict)
        or not isinstance(value["blockers"], list)
        or any(not isinstance(item, str) for item in value["blockers"])
        or (value["status"] != "running" and value["ready"])
    ):
        fail("Adapter", "Invalid adapter result status, readiness, state or blockers.", 5)
    return value


ADAPTER_ERROR_LIMIT = 300


def _adapter_error_line(stderr: str | None) -> str:
    """Return the adapter's last standard-error line, which the contract keeps operator-safe."""
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    if not lines:
        return ""
    return "".join(character for character in lines[-1] if character.isprintable())[:ADAPTER_ERROR_LIMIT]


def _invoke_pinned_adapter(
    adapter: dict[str, Any], action: str, target: dict[str, Any], *, original: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from resource_room import _canonical_path

    path = _canonical_path(adapter["path"], must_exist=True, file=True)
    try:
        actual = hashlib.sha256(path.read_bytes()).hexdigest().upper()
    except OSError as error:
        fail("Adapter", f"Cannot read pinned adapter: {error}", 5)
    if actual != adapter["sha256"]:
        fail("Adapter", "Adapter changed before invocation.", 5)
    convert_resources(target["resources"])
    descriptor_fields = ("id", "fingerprint", "adapter", "resources", "config", "state")
    request = {"action": action, "target": {key: target[key] for key in descriptor_fields}}
    if original is not None:
        request["originalTarget"] = {key: original[key] for key in descriptor_fields}
    if path.suffix.casefold() != ".py":
        fail("Adapter", "This release executes only Python adapters (.py).", 5)
    try:
        completed_process = subprocess.run(
            [sys.executable, str(path)],
            input=json.dumps(request, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            capture_output=True, text=True, encoding="utf-8", errors="strict", check=False,
        )
    except (OSError, UnicodeError, ValueError) as error:
        fail("Adapter", f"Cannot invoke Python adapter: {error}", 5)
    if completed_process.returncode != 0:
        detail = _adapter_error_line(completed_process.stderr)
        suffix = f": {detail}" if detail else "."
        fail("Adapter", f"Python adapter failed with exit code {completed_process.returncode}{suffix}", 5)
    try:
        result = json.loads(completed_process.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        fail("Adapter", f"Python adapter must emit exactly one JSON result: {error}", 5)
    return _adapter_result(result)


def _operation_adapter(store: RoomStore, token: dict[str, Any], target_id: str, action: str) -> dict[str, Any]:
    def prepare(state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        _assert_operation(state, token)
        target = get_target(state, target_id)
        adapter = get_adapter(state, target["adapter"])
        operation = state["operation"]
        if action == "Stop" and target_id not in operation["ownedTargets"]:
            fail("Inventory", f"No established launch/adoption ownership authorizes Stop for {target_id}.", 5)
        if action == "Start":
            operation["launchAttempts"].append({"targetId": target_id, "at": now(), "returned": False, "status": None})
        operation["phase"] = f"{action}:{target_id}"
        add_event(state, operation["phase"], token["owner"])
        return target, adapter

    target, adapter = _transaction(store, prepare)
    result = _invoke_pinned_adapter(adapter, action, target)

    def persist(state: dict[str, Any]) -> None:
        _assert_operation(state, token)
        current = get_target(state, target_id)
        current["state"] = result["state"]
        current["lastInspection"] = {
            "action": action, "status": result["status"], "ready": result["ready"],
            "blockers": result["blockers"], "at": now(),
        }
        operation = state["operation"]
        operation["results"].append({"targetId": target_id, "action": action, "result": result})
        if action == "Start":
            attempt = next(item for item in reversed(operation["launchAttempts"]) if item["targetId"] == target_id)
            attempt["returned"] = True
            attempt["status"] = result["status"]
            if result["status"] in ("running", "unknown") and result["state"] and target_id not in operation["ownedTargets"]:
                operation["ownedTargets"].append(target_id)
        if action == "Inspect" and result["status"] == "stopped":
            operation["ownedTargets"] = [item for item in operation["ownedTargets"] if item != target_id]
            if state["runtime"]["targetId"] == target_id:
                state["runtime"]["owned"] = False
        add_event(state, f"{action}-result", token["owner"], f"{target_id}: {result['status']}")

    _transaction(store, persist)
    return result


def _inventory(store: RoomStore, token: dict[str, Any]) -> list[dict[str, Any]]:
    ids = _transaction(store, lambda state: (_assert_operation(state, token), [item["id"] for item in state["targets"]])[1], read_only=True)
    return [{"id": ident, "result": _operation_adapter(store, token, ident, "Inspect")} for ident in ids]


def _assert_inventory(
    inventory: list[dict[str, Any]], expected_running: str | None,
    *, for_cleanup: bool = False, starting_target: str = "",
) -> None:
    for entry in inventory:
        result = entry["result"]
        ident = entry["id"]
        if result["status"] == "unknown":
            fail("Inventory", f"Unknown/conflicting inventory for {ident}: {'; '.join(result['blockers'])}", 5)
        if ident != expected_running and result["status"] != "stopped":
            fail("Inventory", f"Unexpected running target {ident}. Explicit adoption or reconciliation is required.", 5)
        if ident == expected_running and not for_cleanup and (
            result["status"] != "running" or not result["ready"] or result["blockers"]
        ):
            fail("Inventory", f"Recorded target {ident} is not running and ready: {'; '.join(result['blockers'])}", 5)
        if ident == starting_target and (result["status"] != "stopped" or result["blockers"]):
            fail("Inventory", f"Requested target {ident} is not eligible to start: {'; '.join(result['blockers'])}", 5)


def _mutation_and_inspect(store: RoomStore, token: dict[str, Any], target_id: str, action: str) -> dict[str, Any]:
    mutation_error: BaseException | None = None
    mutation: dict[str, Any] | None = None
    try:
        mutation = _operation_adapter(store, token, target_id, action)
    except BaseException as error:
        mutation_error = error
    inspection = _operation_adapter(store, token, target_id, "Inspect")
    if mutation_error is not None:
        raise mutation_error
    expected = "running" if action == "Start" else "stopped"
    assert mutation is not None
    if (
        mutation["status"] != expected or inspection["status"] != expected
        or (expected == "running" and (
            not mutation["ready"] or mutation["blockers"] or not inspection["ready"] or inspection["blockers"]
        ))
    ):
        fail("Lifecycle", f"{action} did not return and prove {expected} for {target_id}. Ownership remains faulted.", 5)
    return inspection


def _add_runtime_use(state: dict[str, Any], request: dict[str, Any], owner: str) -> dict[str, Any]:
    runtime = state["runtime"]
    use = {
        "id": new_id(), "owner": owner, "roomId": request["roomId"], "targetId": runtime["targetId"],
        "fingerprint": runtime["fingerprint"], "descriptorGeneration": runtime["descriptorGeneration"],
        "runtimeGeneration": runtime["generation"], "purpose": text(request, "purpose"), "created": now(),
    }
    runtime["uses"].append(use)
    if owner not in runtime["participants"]:
        runtime["participants"].append(owner)
    state["requests"] = [item for item in state["requests"] if item["id"] != request["id"]]
    return use


def activate_or_park(
    store: RoomStore, request: dict[str, Any], owner: str, *, prepare: bool = False, park: bool = False,
) -> Any:
    lock = _operation_lock(store, store.action, owner)
    token = None
    try:
        def begin(state: dict[str, Any]) -> dict[str, Any]:
            _assert_boot(store, state)
            get_session(state, owner)
            assert_idle_operation(state)
            runtime = state["runtime"]
            next_request = target = turn = barrier = candidate_room = None
            same = False
            if runtime["turn"] is not None:
                turn = get_owned_turn(state, request, owner)
                if prepare:
                    fail("Busy", "Release the existing prepared turn first.", 6)
                barrier = get_turn_barrier(state, turn, frozen=True)
                if not park:
                    if turn["activated"]:
                        fail("Conflict", "A prepared turn permits one completed activation; park and release it before queueing again.", 3)
                    target = get_target(state, turn["targetId"])
                    assert_target_version(target, turn)
                    next_request = {"id": "", "owner": owner, "roomId": turn["roomId"], "purpose": "prepared candidate verification"}
            elif "turnId" in request:
                fail("Owner", "This prepared turn no longer exists.", 4)
            elif not park:
                request_id = text(request, "requestId")
                matches = [item for item in state["requests"] if item["id"] == request_id]
                if len(matches) != 1:
                    fail("Invalid", "Unknown pending request.")
                next_request = matches[0]
                if next_request["owner"] != owner:
                    fail("Owner", "Only the requester may activate this request.", 4)
                if not state["requests"] or state["requests"][0]["id"] != request_id:
                    fail("Queue", "Another request is ahead in FIFO order.", 3)
                target = get_target(state, next_request["targetId"])
                assert_target_version(target, next_request)
                if prepare:
                    if "barrierGeneration" not in next_request:
                        fail("Barrier", "prepare requires an explicitly candidate-bound request.", 3)
                    candidate_room = get_room(state, next_request["roomId"], owner)
                    barrier = candidate_room.get("barrier")
                    if barrier is None or barrier["frozen"] or barrier["dirty"] or barrier["owner"] != owner:
                        fail("Barrier", "Prepare your own unchanged, unfrozen candidate.", 3)
                    if barrier["generation"] != next_request["barrierGeneration"]:
                        fail("Generation", "Candidate generation changed.", 3)
                    if barrier["candidate"] != next_request["candidate"]:
                        fail("Generation", "Queued candidate changed.", 3)
                elif "barrierGeneration" in next_request:
                    fail("Barrier", "Candidate requests must prepare before freeze/build/activation.", 3)
                same = not prepare and runtime["status"] == "running" and runtime["targetId"] == target["id"]
                if same and not runtime["owned"]:
                    fail("Inventory", "Stopped proof revoked this runtime ownership; reconcile before reuse.", 5)
                if same and (
                    runtime["fingerprint"] != target["fingerprint"]
                    or runtime["descriptorGeneration"] != target["generation"]
                ):
                    fail("Generation", "Active runtime does not match its descriptor.", 5)
            if park:
                if runtime["generation"] != required(request, "runtimeGeneration"):
                    fail("Generation", "Generation changed.", 3)
                _assert_park_participant(state, owner)
            if not same and runtime["uses"]:
                fail("Busy", "Runtime users must release their own uses before a mutation.", 6)
            resources: list[dict[str, Any]] = []
            if not same:
                if runtime["targetId"]:
                    resources += convert_resources(get_target(state, runtime["targetId"])["resources"], exclusive=True)
                if target is not None:
                    resources += convert_resources(target["resources"], exclusive=True)
            except_ids = [item["id"] for item in state["claims"] if item["kind"] == "runtime"]
            if prepare:
                resources += barrier["resources"]
                except_ids += get_claim_ids_for_cohort(state, candidate_room)
            if turn is not None:
                except_ids += [turn["claimId"], barrier["claimId"], *barrier["participantClaimIds"]]
            assert_claims_available(state, resources, except_ids)
            claims = []
            if resources:
                if not prepare:
                    invalidate_readiness(state, resources)
                claims.append(add_claim(state, owner, "", "operation", resources))
            kind = "park" if park else "prepare" if prepare else "activate"
            target_id = target["id"] if target is not None else ""
            request_id = next_request["id"] if next_request is not None else ""
            new_token = _new_operation(state, owner, kind, target_id, claims, request_id)
            if barrier is not None:
                new_barrier = candidate_room if prepare else get_room(state, turn["roomId"], owner)
                state["operation"]["barrier"] = {"roomId": new_barrier["id"], "generation": barrier["generation"]}
            return {
                "token": new_token, "previous": runtime["targetId"], "targetId": target_id, "same": same,
                "next": next_request, "barrier": barrier, "turn": turn,
            }

        start = _transaction(store, begin)
        token = start["token"]
        inventory = _inventory(store, token)
        starting_target = start["targetId"] if not park and not prepare and not start["same"] else ""
        _assert_inventory(inventory, start["previous"], for_cleanup=not start["same"], starting_target=starting_target)
        if not start["same"]:
            if start["previous"]:
                old_result = next(item["result"] for item in inventory if item["id"] == start["previous"])
                if old_result["status"] != "stopped":
                    _mutation_and_inspect(store, token, start["previous"], "Stop")
                _assert_inventory(_inventory(store, token), None, starting_target=starting_target)
            if not park and not prepare:
                _mutation_and_inspect(store, token, start["targetId"], "Start")
                _assert_inventory(_inventory(store, token), start["targetId"])

        def finish(state: dict[str, Any]) -> Any:
            _assert_operation(state, token)
            runtime = state["runtime"]
            if not start["same"]:
                state["claims"] = [claim for claim in state["claims"] if claim["kind"] != "runtime"]
                runtime["generation"] += 1
                runtime["owner"] = owner
                runtime["participants"] = []
                runtime["owned"] = False
                if park or prepare:
                    runtime.update(status="stopped", targetId=None, fingerprint=None, descriptorGeneration=0)
                else:
                    current_target = get_target(state, start["targetId"])
                    runtime.update(
                        status="running", targetId=current_target["id"], fingerprint=current_target["fingerprint"],
                        descriptorGeneration=current_target["generation"], owned=True,
                    )
                    state["operation"]["ownedTargets"] = [current_target["id"]]
                    add_claim(state, owner, "", "runtime", current_target["resources"])
            use = None
            if prepare:
                current_target = get_target(state, start["targetId"])
                reserved = list(start["barrier"]["resources"]) + convert_resources(current_target["resources"], exclusive=True)
                claim = add_claim(state, owner, start["next"]["roomId"], "turn", reserved)
                runtime["turn"] = {
                    "id": new_id(), "generation": 1, "owner": owner, "roomId": start["next"]["roomId"],
                    "barrierGeneration": start["barrier"]["generation"], "candidate": start["barrier"]["candidate"],
                    "targetId": current_target["id"], "fingerprint": current_target["fingerprint"],
                    "descriptorGeneration": current_target["generation"], "resources": reserved,
                    "claimId": claim["id"], "activated": False,
                }
                state["requests"] = [item for item in state["requests"] if item["id"] != start["next"]["id"]]
            elif not park:
                use = _add_runtime_use(state, start["next"], owner)
                if runtime["turn"] is not None:
                    runtime["turn"]["activated"] = True
            _complete(state, token)
            return {"runtime": runtime, "use": use, "turn": runtime["turn"]}

        return _transaction(store, finish)
    except BaseException as error:
        if token is not None:
            try:
                _fault(store, token, error)
            except BaseException:
                pass
        raise
    finally:
        lock.close()


def _pending_descriptor_stopped(store: RoomStore, token: dict[str, Any]) -> dict[str, Any] | None:
    def select(state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
        _assert_operation(state, token)
        descriptor = state["operation"].get("pendingDescriptor")
        if descriptor is None:
            return None
        return descriptor, get_adapter(state, descriptor["adapter"])

    selected = _transaction(store, select, read_only=True)
    if selected is None:
        return None
    descriptor, adapter = selected
    inspection = _invoke_pinned_adapter(adapter, "Inspect", descriptor)

    def persist(state: dict[str, Any]) -> None:
        _assert_operation(state, token)
        state["operation"]["pendingDescriptor"]["state"] = inspection["state"]
        state["operation"]["results"].append({
            "targetId": descriptor["id"], "action": "InspectReplacement", "result": inspection,
        })

    _transaction(store, persist)
    if inspection["status"] != "stopped":
        fail("Inventory", "Replacement descriptor must independently prove stopped; its unresolved inventory remains part of recovery.", 5)
    return inspection


def _scope_expansion(
    old: dict[str, Any], replacement: dict[str, Any],
    old_scopes: list[tuple[str, str, str]], new_scopes: list[tuple[str, str, str]],
) -> list[tuple[str, str, str]]:
    if replacement["id"] != old["id"]:
        fail("Descriptor", "Scope expansion requires the exact same target ID.", 3)
    retained = set(old_scopes)
    if not retained <= set(new_scopes):
        fail("Descriptor", "Scope expansion must preserve every existing identity and mode; omissions, rebinds and mode changes are rejected.", 3)
    added = sorted(set(new_scopes) - retained)
    known = {(kind, identity) for kind, identity, _ in retained}
    if not added or any((kind, identity) in known for kind, identity, _ in added):
        fail("Descriptor", "Scope expansion must add only new identities; an empty addition or a changed mode is not an expansion.", 3)
    return added


def supersede_target(store: RoomStore, request: dict[str, Any], owner: str) -> Any:
    expanding = "confirm" in request
    if expanding and request["confirm"] != "EXPAND_STOPPED":
        fail("Invalid", "Scope expansion requires confirm: EXPAND_STOPPED; any other confirmation is rejected.")
    lock = _operation_lock(store, "supersede-target", owner)
    token = None
    try:
        def begin(state: dict[str, Any]) -> dict[str, Any]:
            _assert_boot(store, state)
            get_session(state, owner)
            assert_idle_operation(state)
            runtime = state["runtime"]
            if runtime["targetId"] or runtime["uses"]:
                fail("Busy", "Park all runtime use before descriptor supersession.", 6)
            old = get_target(state, text(request, "targetId"))
            assert_target_version(old, request)
            turn = None
            except_ids: list[str] = []
            if runtime["turn"] is not None and expanding:
                fail("Conflict", "Scope expansion cannot proceed while a prepared turn exists; use exact supersession for its unactivated candidate.", 3)
            if runtime["turn"] is not None:
                turn = get_owned_turn(state, request, owner)
                barrier = get_turn_barrier(state, turn, frozen=True)
                if turn["targetId"] != old["id"] or turn["activated"]:
                    fail("Conflict", "Only the unactivated prepared candidate descriptor may be refreshed.", 3)
                except_ids = [turn["claimId"], barrier["claimId"], *barrier["participantClaimIds"]]
            elif "turnId" in request:
                fail("Owner", "This prepared turn no longer exists.", 4)
            elif state["requests"]:
                fail("Queue", "Queued runtime work takes precedence over unreserved descriptor supersession.", 3)
            if any(item["targetId"] == old["id"] for item in state["requests"]):
                fail("Busy", "Outstanding requests still reference this descriptor generation.", 6)
            replacement = new_descriptor(state, required(request, "target"), owner)
            if any(item["id"].casefold() == replacement["id"].casefold() and item["id"] != old["id"] for item in state["targets"]):
                fail("Descriptor", "Replacement target ID is already registered.", 3)
            old_scopes = sorted({(x["kind"], x["identity"], x["mode"]) for x in old["resources"]})
            new_scopes = sorted({(x["kind"], x["identity"], x["mode"]) for x in replacement["resources"]})
            added: list[tuple[str, str, str]] = []
            if expanding:
                added = _scope_expansion(old, replacement, old_scopes, new_scopes)
            elif old_scopes != new_scopes:
                fail("Descriptor", "Supersession must preserve every physical resource identity and mode; no coverage may be omitted or rebound.", 3)
            source = [*old["resources"], *replacement["resources"]] if expanding else old["resources"]
            resources = convert_resources(source, exclusive=True)
            assert_claims_available(state, resources, except_ids)
            if expanding:
                invalidate_readiness(state, resources)
            claim = add_claim(state, owner, "", "operation", resources)
            new_token = _new_operation(state, owner, "supersede-target", old["id"], [claim])
            state["operation"]["pendingDescriptor"] = replacement
            if turn is not None:
                state["operation"]["barrier"] = {"roomId": turn["roomId"], "generation": turn["barrierGeneration"]}
            return {"token": new_token, "old": old, "replacement": replacement, "added": added}

        start = _transaction(store, begin)
        token = start["token"]
        _assert_inventory(_inventory(store, token), None)
        inspection = _pending_descriptor_stopped(store, token)

        def finish(state: dict[str, Any]) -> Any:
            _assert_operation(state, token)
            old = get_target(state, start["old"]["id"])
            if old["generation"] != start["old"]["generation"]:
                fail("Generation", "Target generation changed.", 3)
            replacement = start["replacement"]
            assert inspection is not None
            replacement["state"] = inspection["state"]
            replacement["lastInspection"] = {
                "action": "Inspect", "status": inspection["status"], "ready": inspection["ready"],
                "blockers": inspection["blockers"], "at": now(),
            }
            record = {
                "kind": "descriptor-supersession", "owner": owner, "at": now(), "retired": old,
                "replacementId": replacement["id"], "replacementGeneration": replacement["generation"],
            }
            if start["added"]:
                record["kind"] = "descriptor-expansion"
                record["addedResources"] = [
                    {"kind": kind, "identity": identity, "mode": mode} for kind, identity, mode in start["added"]
                ]
            state["history"].append(record)
            state["targetGeneration"] = replacement["generation"]
            state["targets"] = [item for item in state["targets"] if item["id"] != old["id"]] + [replacement]
            turn = state["runtime"]["turn"]
            if turn is not None:
                turn.update(
                    targetId=replacement["id"], fingerprint=replacement["fingerprint"],
                    descriptorGeneration=replacement["generation"], generation=turn["generation"] + 1,
                )
            _complete(state, token)
            return {"target": replacement, "turn": turn}

        return _transaction(store, finish)
    except BaseException as error:
        if token is not None:
            try:
                _fault(store, token, error)
            except BaseException:
                pass
        raise
    finally:
        lock.close()


def rebind_adapter(store: RoomStore, request: dict[str, Any], owner: str) -> Any:
    if (type(request.get("protocolVersion")) is not int or request["protocolVersion"] != 1
            or request.get("confirm") != "REBIND_STOPPED"):
        fail("Invalid", "Rebind requires protocolVersion 1 and confirmation REBIND_STOPPED.")
    if ("oldAdapter" in request) == ("oldAdapters" in request):
        fail("Invalid", "Rebind requires exactly one of oldAdapter or oldAdapters.")
    raw_old = [required(request, "oldAdapter")] if "oldAdapter" in request else required(request, "oldAdapters")
    if not isinstance(raw_old, list) or not raw_old:
        fail("Invalid", "Rebind oldAdapters must be a nonempty array.")
    old_pins = [require_map(item, "Old adapter") for item in raw_old]
    old_keys = [text(pin, "name").casefold() for pin in old_pins]
    if len(set(old_keys)) != len(old_keys):
        fail("Conflict", "Rebind old adapter registrations must be distinct.", 3)
    new_pin = require_map(required(request, "newAdapter"), "newAdapter")
    new_name = text(new_pin, "name")
    if new_name.casefold() in old_keys:
        fail("Conflict", "A rebind requires a distinct registered adapter name.", 3)
    entries = required(request, "targets")
    if not isinstance(entries, list) or not entries:
        fail("Invalid", "Rebind targets must be a nonempty array.")

    def select(state: dict[str, Any]) -> tuple:
        _assert_boot(store, state)
        get_session(state, owner)
        assert_idle_operation(state)
        runtime = state["runtime"]
        if runtime["status"] != "stopped" or runtime["targetId"] or runtime["uses"] or runtime["turn"] is not None:
            fail("Busy", "Park the machine and release all uses and prepared turns before rebinding an adapter.", 6)

        # Compare the old registrations without touching an unusable or missing pinned file.
        registrations = {}
        for old_pin, key in zip(old_pins, old_keys):
            registration = next((pin for pin in state["adapters"] if pin["name"].casefold() == key), None)
            if registration is None or registration["sha256"] != text(old_pin, "sha256").upper():
                fail("Conflict", "The exact old adapter registration does not match.", 3)
            registrations[key] = registration
        new_adapter = get_adapter(state, new_name)
        if new_adapter["name"] != new_name or new_adapter["sha256"] != text(new_pin, "sha256").upper():
            fail("Conflict", "The exact replacement adapter registration does not match.", 3)

        originals = {item["id"]: item for item in state["targets"] if item["adapter"].casefold() in registrations}
        for key in registrations:
            if not any(item["adapter"].casefold() == key for item in originals.values()):
                fail("Conflict", "Every selected old adapter pin must own at least one target.", 3)
        changes = {}
        for item in entries:
            entry = require_map(item, "Rebind target")
            ident = text(entry, "targetId")
            if ident not in originals or ident in changes:
                fail("Conflict", "Rebind targets must name each exact old-pin target once.", 3)
            original = originals[ident]
            assert_target_version(original, entry)
            replacement = new_descriptor(state, required(entry, "target"), owner)
            if (replacement["id"] != ident or replacement["adapter"] != new_name
                    or replacement["resources"] != original["resources"]):
                fail("Conflict", "Rebind must preserve the target ID and every physical resource identity and mode.", 3)
            changes[ident] = replacement
        if changes.keys() != originals.keys():
            fail("Conflict", "Rebind must cover every target using a selected old adapter pin.", 3)
        if any(item["targetId"] in originals for item in state["requests"]):
            fail("Busy", "Cancel outstanding requests for the old descriptor generations first.", 6)
        assert_claims_available(state, [
            resource for original in originals.values()
            for resource in convert_resources(original["resources"], exclusive=True)
        ])
        return state["revision"], registrations, new_adapter, changes, [
            (target, new_adapter if target["id"] in changes else get_adapter(state, target["adapter"]))
            for target in state["targets"]
        ]

    lock = _operation_lock(store, store.action, owner)
    try:
        revision, registrations, new_adapter, changes, inventory = _transaction(store, select, read_only=True)
        inspections = {}
        for target, adapter in inventory:
            ident = target["id"]
            if ident in changes:
                result = _invoke_pinned_adapter(adapter, "InspectRebind", changes[ident], original=target)
                inspections[ident] = result
            else:
                result = _invoke_pinned_adapter(adapter, "Inspect", target)
            if result["status"] != "stopped" or result["blockers"]:
                fail("Lifecycle", f"Rebind requires a stopped, unblocked inspection for {ident}.", 5)

        def finish(state: dict[str, Any]) -> Any:
            if state["revision"] != revision:
                fail("Conflict", "Coordinator state changed during read-only rebind inspection; retry with a fresh snapshot.", 3)
            _assert_boot(store, state)
            get_session(state, owner)
            for name in {adapter["name"] for _, adapter in inventory}:
                get_adapter(state, name)
            for index, old in enumerate(state["targets"]):
                ident = old["id"]
                if ident not in changes:
                    continue
                replacement = changes[ident]
                state["targetGeneration"] += 1
                replacement["generation"] = state["targetGeneration"]
                replacement["state"] = inspections[ident]["state"]
                replacement["lastInspection"] = {
                    "action": "InspectRebind", "status": "stopped", "ready": False, "blockers": [], "at": now(),
                }
                state["history"].append({
                    "kind": "adapter-rebind", "owner": owner, "at": now(), "oldTarget": old,
                    "oldAdapter": registrations[old["adapter"].casefold()], "newAdapter": new_adapter,
                    "replacementId": ident, "replacementGeneration": replacement["generation"],
                })
                state["targets"][index] = replacement
            add_event(state, "rebind-adapter", owner)
            return {"targets": list(changes.values())}

        return _transaction(store, finish)
    finally:
        lock.close()


def _run_script(path: pathlib.Path, parameters: dict[str, Any]) -> list[str]:
    if path.suffix.casefold() != ".py":
        fail("Invalid", "run requires a Python .py script.", 2)
    try:
        result = subprocess.run(
            [sys.executable, str(path)],
            input=json.dumps(parameters, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            capture_output=True, text=True, encoding="utf-8", errors="strict", check=False,
        )
    except (OSError, UnicodeError, ValueError) as error:
        fail("Command", f"Cannot invoke run script: {error}", 7)
    if result.returncode != 0:
        fail("Command", f"Run script returned exit code {result.returncode}.", 7)
    return result.stdout.splitlines()


def run_room_script(store: RoomStore, request: dict[str, Any], owner: str) -> Any:
    path = pathlib.Path(text(request, "scriptPath"))
    from resource_room import _canonical_path

    path = _canonical_path(str(path), must_exist=True, file=True)
    sha = text(request, "sha256").upper()
    try:
        actual = hashlib.sha256(path.read_bytes()).hexdigest().upper()
    except OSError as error:
        fail("Invalid", f"Cannot read run script: {error}")
    if actual != sha:
        fail("Invalid", "Run script SHA256 mismatch.")
    parameters = required(request, "parameters")
    if not isinstance(parameters, dict):
        fail("Invalid", "parameters must be an object.")
    resources = convert_resources(required(request, "resources"))
    effects = text(request, "effects")
    if effects not in ("offline", "runtime"):
        fail("Invalid", "effects must be offline or runtime; declare all physical effects as resources.")
    lock = _operation_lock(store, "run", owner)
    token = None
    try:
        def begin(state: dict[str, Any]) -> dict[str, Any]:
            _assert_boot(store, state)
            get_session(state, owner)
            room = get_room(state, text(request, "roomId"), owner)
            assert_idle_operation(state)
            if any(item["owner"] == owner for item in state["requests"]):
                fail("Conflict", "Cancel or complete queued requests before running with claims.", 3)
            except_ids: list[str] = []
            barrier = None
            if "barrierGeneration" in request:
                barrier = room.get("barrier")
                if barrier is None or not barrier["frozen"] or barrier["owner"] != owner:
                    fail("Owner", "run requires your own frozen barrier.", 4)
                if barrier["generation"] != request["barrierGeneration"]:
                    fail("Generation", "Generation changed.", 3)
                if text(request, "candidate") != barrier["candidate"]:
                    fail("Generation", "Frozen candidate mismatch.", 3)
                except_ids += [barrier["claimId"], *barrier["participantClaimIds"]]
            turn = state["runtime"]["turn"]
            if turn is not None:
                turn = get_owned_turn(state, request, owner)
                get_turn_barrier(state, turn, frozen=True)
                if barrier is None or room["id"] != turn["roomId"] or not _resources_contained(resources, turn["resources"]):
                    fail("Barrier", "Prepared-turn operations must declare the exact frozen candidate and remain inside its reserved resources.", 3)
                except_ids.append(turn["claimId"])
            elif "turnId" in request:
                fail("Owner", "This prepared turn no longer exists.", 4)
            target_id = ""
            if effects == "runtime":
                target = get_target(state, text(request, "targetId"))
                assert_target_version(target, request)
                if state["runtime"]["generation"] != required(request, "runtimeGeneration"):
                    fail("Generation", "Generation changed.", 3)
                if state["runtime"]["targetId"] != target["id"] or state["runtime"]["status"] != "running":
                    fail("Generation", "runtime run requires the exact active target.", 3)
                if state["runtime"]["uses"]:
                    fail("Busy", "Release all shared runtime uses before mutation.", 6)
                if state["requests"] and state["runtime"]["turn"] is None:
                    fail("Queue", "A queued runtime requester takes priority over a new mutation.", 3)
                resources.extend(convert_resources(target["resources"], exclusive=True))
                except_ids += [item["id"] for item in state["claims"] if item["kind"] == "runtime"]
                target_id = target["id"]
            assert_claims_available(state, resources, except_ids)
            invalidate_readiness(state, resources)
            claim = add_claim(state, owner, room["id"], "operation", resources)
            new_token = _new_operation(state, owner, "run", target_id, [claim])
            state["operation"]["scriptPath"] = str(path)
            state["operation"]["scriptSha256"] = sha
            if barrier is not None:
                state["operation"]["barrier"] = {"roomId": room["id"], "generation": barrier["generation"]}
            return {"token": new_token, "active": state["runtime"]["targetId"]}

        start = _transaction(store, begin)
        token = start["token"]
        _assert_inventory(_inventory(store, token), start["active"], for_cleanup=effects == "offline")
        _set_phase(store, token, "run-script")
        try:
            if hashlib.sha256(path.read_bytes()).hexdigest().upper() != sha:
                fail("Invalid", "Run script changed before invocation.")
        except OSError as error:
            fail("Invalid", f"Cannot reread run script: {error}")
        output = _run_script(path, parameters)
        _assert_inventory(_inventory(store, token), start["active"], for_cleanup=effects == "offline")

        def finish(state: dict[str, Any]) -> dict[str, Any]:
            _assert_operation(state, token)
            if effects == "runtime":
                state["runtime"]["generation"] += 1
            _complete(state, token)
            return {"output": output, "runtimeGeneration": state["runtime"]["generation"]}

        return _transaction(store, finish)
    except BaseException as error:
        if token is not None:
            try:
                _fault(store, token, error)
            except BaseException:
                pass
        raise
    finally:
        lock.close()


def _release_unstarted_run(
    store: RoomStore, state: dict[str, Any], operation: dict[str, Any], owner: str,
) -> dict[str, Any]:
    _assert_boot(store, state)
    runtime = state["runtime"]
    # Post-script Inspect can reuse this phase, but preflight must have persisted
    # an Inspect result for every registered target before the script ran.
    if (
        operation["kind"] != "run" or operation["status"] != "faulted"
        or operation["results"] or operation["ownedTargets"] or operation["launchAttempts"]
        or operation["previousTarget"] or operation["requestedTarget"] or operation["requestId"]
        or operation["barrier"] is not None or operation.get("pendingDescriptor") is not None
        or not any(operation["phase"] == f"Inspect:{target['id']}" for target in state["targets"])
        or runtime["status"] != "faulted" or runtime["targetId"] is not None
        or runtime["owned"] or runtime["participants"] or runtime["turn"] is not None
        or any(claim["kind"] == "runtime" for claim in state["claims"])
    ):
        fail("Recovery", "Cannot prove this run failed in its first preflight Inspect without a reserved runtime.", 5)
    claims = [claim for claim in state["claims"] if claim["id"] in operation["claimIds"]]
    if len(operation["claimIds"]) != 1 or len(claims) != 1 or claims[0]["owner"] != owner:
        fail("Recovery", "Cannot identify the run owner's exact reservation.", 5)
    state["claims"].remove(claims[0])
    state["history"].append(operation)
    state["operation"] = None
    runtime["status"] = "stopped"
    runtime["generation"] += 1
    add_event(state, "released-unstarted-run", owner, operation["id"])
    return {"releasedUnstartedRun": operation["id"], "runtimeGeneration": runtime["generation"]}


def recover_room(store: RoomStore, request: dict[str, Any], owner: str) -> Any:
    if text(request, "confirm") != "RECONCILE":
        fail("Invalid", "Recovery requires confirm: RECONCILE.")
    mode = text(request, "mode")
    if mode not in ("verify-stopped", "stop-owned", "adopt", "release-unstarted-run"):
        fail("Invalid", "Unknown recovery mode.")
    lock = _operation_lock(store, "recover", owner)
    token = None
    try:
        def begin(state: dict[str, Any]) -> dict[str, Any]:
            get_session(state, owner)
            runtime = state["runtime"]
            if runtime["uses"]:
                fail("Busy", "Each owner must release its uses before recovery.", 6)
            old_operation = state.get("operation")
            if old_operation is not None:
                if old_operation["owner"] != owner:
                    fail("Owner", "Resume the fault owner session; recovery never steals another session.", 4)
                if text(request, "operationId") != old_operation["id"]:
                    fail("Owner", "Recovery operation token mismatch.", 4)
                if old_operation["generation"] != required(request, "operationGeneration"):
                    fail("Generation", "Generation changed.", 3)
                if mode == "release-unstarted-run":
                    return _release_unstarted_run(store, state, old_operation, owner)
                if (old_operation["kind"] == "run" or old_operation["requiresResourceReconciliation"]) and request.get("resourcesReconciled") is not True:
                    fail("Invalid", "A failed run requires explicit resourcesReconciled:true after checking its exact children and effects.")
            else:
                if mode == "release-unstarted-run":
                    fail("Recovery", "There is no retained run to release.", 5)
                if runtime["generation"] != required(request, "runtimeGeneration"):
                    fail("Generation", "Generation changed.", 3)
                _assert_park_participant(state, owner)
            owned = list(old_operation["ownedTargets"]) if old_operation is not None else (
                [runtime["targetId"]] if runtime["targetId"] and runtime["owned"] else []
            )
            old_claims = list(old_operation["claimIds"]) if old_operation is not None else []
            if old_operation is not None:
                old_operation["status"] = "reconciling"
                state["history"].append(old_operation)
            adopt = ""
            if mode == "adopt":
                target = get_target(state, text(request, "targetId"))
                assert_target_version(target, request)
                adopt = target["id"]
            resources: list[dict[str, Any]] = []
            for ident in dict.fromkeys([*owned, *([adopt] if adopt else [])]):
                resources.extend(convert_resources(get_target(state, ident)["resources"], exclusive=True))
            except_ids = [item["id"] for item in state["claims"] if item["kind"] == "runtime"] + old_claims
            recovery_barrier = old_operation.get("barrier") if old_operation is not None else None
            turn = runtime["turn"]
            if turn is not None:
                if turn["owner"] != owner:
                    fail("Owner", "Recovery must preserve the prepared-turn owner.", 4)
                if mode == "adopt" and adopt != turn["targetId"]:
                    fail("Owner", "A prepared turn cannot adopt an unrelated candidate.", 4)
                except_ids.append(turn["claimId"])
                turn_room = get_room(state, turn["roomId"], owner)
                turn_barrier = turn_room.get("barrier")
                if turn_barrier is not None:
                    if turn_barrier["generation"] != turn["barrierGeneration"]:
                        fail("Generation", "Generation changed.", 3)
                    if (
                        turn_barrier["candidate"] != turn["candidate"] or turn_barrier["owner"] != turn["owner"]
                        or (recovery_barrier is not None and (
                            recovery_barrier["roomId"] != turn["roomId"]
                            or recovery_barrier["generation"] != turn["barrierGeneration"]
                        ))
                    ):
                        fail("Owner", "Recovery barrier must match the exact prepared candidate.", 4)
                    recovery_barrier = {"roomId": turn["roomId"], "generation": turn["barrierGeneration"]}
            if recovery_barrier is not None:
                room = get_room(state, recovery_barrier["roomId"], owner)
                barrier = room.get("barrier")
                if barrier is not None and barrier["generation"] == recovery_barrier["generation"]:
                    except_ids.extend([barrier["claimId"], *barrier["participantClaimIds"]])
                    if not barrier["frozen"]:
                        except_ids.extend(get_claim_ids_for_cohort(state, room))
            assert_claims_available(state, resources, except_ids)
            recovery_claims = []
            if resources:
                if recovery_barrier is None:
                    invalidate_readiness(state, resources)
                recovery_claims.append(add_claim(state, owner, "", "operation", resources))
            new_token = _new_operation(state, owner, "recover", adopt, recovery_claims)
            state["operation"]["claimIds"].extend(old_claims)
            state["operation"]["ownedTargets"] = owned
            state["operation"]["barrier"] = recovery_barrier
            if old_operation is not None:
                state["operation"]["requiresResourceReconciliation"] = old_operation["requiresResourceReconciliation"]
                if "pendingDescriptor" in old_operation:
                    state["operation"]["pendingDescriptor"] = old_operation["pendingDescriptor"]
            return {"token": new_token, "owned": owned, "adopt": adopt}

        start = _transaction(store, begin)
        if mode == "release-unstarted-run":
            return start
        token = start["token"]
        inventory = _inventory(store, token)
        _pending_descriptor_stopped(store, token)
        if mode == "stop-owned":
            for entry in inventory:
                if entry["result"]["status"] != "stopped" and (
                    entry["id"] not in start["owned"] or not entry["result"]["state"]
                ):
                    fail("Inventory", f"Cannot stop unowned or unidentified target {entry['id']}. Resolve it explicitly outside the coordinator.", 5)
            for entry in inventory:
                if entry["result"]["status"] != "stopped":
                    _mutation_and_inspect(store, token, entry["id"], "Stop")
            inventory = _inventory(store, token)
        expected = start["adopt"] or None
        _assert_inventory(inventory, expected)

        def finish(state: dict[str, Any]) -> Any:
            _assert_operation(state, token)
            current_resources = convert_resources(get_target(state, start["adopt"])["resources"]) if start["adopt"] else []
            except_claims = [item["id"] for item in state["claims"] if item["kind"] == "runtime"]
            except_claims.extend(state["operation"]["claimIds"])
            turn = state["runtime"]["turn"]
            if turn is not None:
                except_claims.append(turn["claimId"])
                room = get_room(state, turn["roomId"], owner)
                barrier = room.get("barrier")
                if barrier is not None and barrier["frozen"]:
                    except_claims.extend([barrier["claimId"], *barrier["participantClaimIds"]])
            assert_claims_available(state, current_resources, except_claims)
            runtime = state["runtime"]
            state["claims"] = [claim for claim in state["claims"] if claim["kind"] != "runtime"]
            if start["adopt"]:
                target = get_target(state, start["adopt"])
                runtime.update(
                    targetId=target["id"], fingerprint=target["fingerprint"],
                    descriptorGeneration=target["generation"], status="running",
                    participants=[owner], owned=True,
                )
                add_claim(state, owner, "", "runtime", target["resources"])
                if runtime["turn"] is not None:
                    runtime["turn"]["activated"] = True
            else:
                runtime.update(targetId=None, fingerprint=None, descriptorGeneration=0, status="stopped",
                               participants=[], owned=False)
            runtime["owner"] = owner
            runtime["generation"] += 1
            state["boot"] = store.boot
            state["operation"]["ownedTargets"] = [start["adopt"]] if start["adopt"] else []
            _complete(state, token)
            return {"runtime": runtime, "recovered": True}

        return _transaction(store, finish)
    except BaseException as error:
        if token is not None:
            try:
                _fault(store, token, error)
            except BaseException:
                pass
        raise
    finally:
        lock.close()
