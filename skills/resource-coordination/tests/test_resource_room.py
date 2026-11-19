import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "resource_room.py"


class CoordinatorCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="resource-room-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / "rooms"
        self.environment = os.environ.copy()
        self.first = self.action("join", {"client": "test", "purpose": "first", "name": "room"})["data"]
        self.second = self.action("join", {
            "client": "test", "purpose": "second", "roomId": self.first["roomId"]
        })["data"]

    def invoke(self, action, request=None, *, check=True):
        command = [sys.executable, str(CLI), "--root", str(self.root), "--action", action]
        if request is not None:
            command.extend(("--request-json", json.dumps(request, separators=(",", ":"))))
        process = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", env=self.environment, timeout=15,
        )
        try:
            envelope = json.loads(process.stdout)
        except json.JSONDecodeError as error:
            self.fail(f"Invalid CLI JSON (exit {process.returncode}): {process.stdout} {process.stderr}: {error}")
        if check and process.returncode:
            self.fail(f"Action {action} failed ({process.returncode}): {envelope}")
        return process, envelope

    def action(self, action, request=None, *, session=None, check=True):
        body = dict(request or {})
        if session is not None:
            body["sessionId"] = session["sessionId"]
        result = self.invoke(action, body, check=check)
        return result if not check else result[1]

    def resource(self, identity, kind="key", mode="exclusive"):
        return {"kind": kind, "identity": identity, "mode": mode}

    def register_fake_target(self, identity="runtime:test", target_id="test-target", *, start_unknown=False,
                             stop_fails=False, inspect_failure_flag=None):
        state_file = self.root.parent / f"{target_id}-world.json"
        adapter = self.root.parent / f"{target_id}_adapter.py"
        adapter.write_text(
            "import json, pathlib, sys\n"
            "request = json.load(sys.stdin)\n"
            "target = request['target']\n"
            "path = pathlib.Path(target['config']['stateFile'])\n"
            "active = path.exists() and path.read_text(encoding='utf-8') == 'active'\n"
            "action = request['action']\n"
            "flag = target['config'].get('inspectFailureFlag')\n"
            "if action == 'Inspect' and flag and pathlib.Path(flag).exists():\n"
            "    raise RuntimeError('inspect failed')\n"
            "if action == 'Start':\n"
            "    path.write_text('active', encoding='utf-8')\n"
            "    active = True\n"
            "if action == 'Stop':\n"
            "    if target['config'].get('stopFails', False):\n"
            "        raise RuntimeError('stop failed')\n"
            "    path.unlink(missing_ok=True)\n"
            "    active = False\n"
            "unknown = action == 'Start' and target['config'].get('startUnknown', False)\n"
            "result = {'status': 'unknown' if unknown else ('running' if active else 'stopped'), 'ready': active and not unknown,\n"
            "          'state': {'launchId': 'owned'} if active else {}, 'blockers': []}\n"
            "print(json.dumps(result, separators=(',', ':')))\n",
            encoding="utf-8",
        )
        adapter_hash = hashlib.sha256(adapter.read_bytes()).hexdigest().upper()
        self.action("register-adapter", {
            "name": target_id, "path": str(adapter), "sha256": adapter_hash,
        }, session=self.first)
        return self.action("register-target", {"target": {
            "id": target_id, "fingerprint": "target-v1", "adapter": target_id,
            "resources": [self.resource(identity, mode="shared")],
            "config": {"stateFile": str(state_file), "startUnknown": start_unknown, "stopFails": stop_fails,
                       "inspectFailureFlag": str(inspect_failure_flag) if inspect_failure_flag else None},
            "state": {},
        }}, session=self.first)["data"]

    def queue(self, target, session=None):
        session = session or self.first
        return self.action("request", {
            "roomId": session["roomId"], "targetId": target["id"],
            "fingerprint": target["fingerprint"], "descriptorGeneration": target["generation"],
            "purpose": "lifecycle regression",
        }, session=session)["data"]

    def test_join_inspect_and_keyed_join(self):
        before = json.loads((self.root / "state.json").read_text(encoding="utf-8"))["data"]["revision"]
        inspect = self.action("inspect")["data"]
        self.assertFalse(inspect["recoveryRequired"])
        self.assertEqual(inspect["state"]["schema"], 2)
        after = json.loads((self.root / "state.json").read_text(encoding="utf-8"))["data"]["revision"]
        self.assertEqual(before, after)
        third = self.action("join", {
            "client": "test", "purpose": "keyed", "name": "canonical", "roomKey": "Cafe\u0301"
        })["data"]
        fourth = self.action("join", {
            "client": "test", "purpose": "same key", "name": "ignored", "roomKey": "Caf\u00e9"
        })["data"]
        self.assertEqual(third["roomId"], fourth["roomId"])
        self.assertEqual(third["roomKey"], "CAF\u00c9")

    def test_records_messages_readiness_cancellation_and_departure(self):
        record = self.action("record", {
            "roomId": self.first["roomId"], "key": "candidate", "value": {"revision": 1},
        }, session=self.first)["data"]
        self.assertEqual(record["value"], {"revision": 1})
        process, failure = self.action("record", {
            "roomId": self.first["roomId"], "key": "CANDIDATE", "value": {"revision": 2},
        }, session=self.first, check=False)
        self.assertEqual(process.returncode, 3)
        self.assertEqual(failure["code"], "Conflict")
        message = self.action("message", {
            "roomId": self.first["roomId"], "text": "ready", "data": {"source": "test"},
        }, session=self.second)["data"]
        self.assertEqual(message["data"], {"source": "test"})

        barrier = self.action("cohort", {
            "roomId": self.first["roomId"], "expectedGeneration": 0, "candidate": "candidate-v1",
            "cohort": [self.first["sessionId"], self.second["sessionId"]],
            "resources": [self.resource("candidate:records")],
        }, session=self.first)["data"]
        readiness = {
            "roomId": self.first["roomId"], "generation": barrier["generation"], "candidate": "candidate-v1",
        }
        self.action("ready", readiness, session=self.second)
        self.action("unready", readiness, session=self.second)
        self.assertEqual(self.action("inspect")["data"]["state"]["rooms"][0]["barrier"]["ready"], [])

        narrowed = self.action("cohort", {
            "roomId": self.first["roomId"], "expectedGeneration": barrier["generation"], "candidate": "candidate-v2",
            "cohort": [self.first["sessionId"]], "resources": [self.resource("candidate:records")],
        }, session=self.first)["data"]
        target = self.register_fake_target()
        queued = self.action("request", {
            "roomId": self.first["roomId"], "targetId": target["id"],
            "fingerprint": target["fingerprint"], "descriptorGeneration": target["generation"],
            "purpose": "cancel test",
        }, session=self.first)["data"]
        cancelled = self.action("cancel", {"requestId": queued["id"]}, session=self.first)["data"]
        self.assertEqual(cancelled["cancelled"], queued["id"])
        self.action("leave", {}, session=self.second)
        final = self.action("inspect")["data"]["state"]
        departed = next(item for item in final["sessions"] if item["id"] == self.second["sessionId"])
        self.assertTrue(departed["left"])
        self.assertNotIn(self.second["sessionId"], final["rooms"][0]["members"])
        self.assertEqual(narrowed["candidate"], "candidate-v2")

    def test_conflicting_manual_claim_is_rejected(self):
        resource = self.resource("shared:build")
        claim = self.action("claim", {"roomId": self.first["roomId"], "resources": [resource]},
                            session=self.first)["data"]
        process, envelope = self.action(
            "claim", {"roomId": self.first["roomId"], "resources": [resource]},
            session=self.second, check=False
        )
        self.assertEqual(process.returncode, 3)
        self.assertEqual(envelope["code"], "Conflict")
        released = self.action("release", {"claimId": claim["id"]}, session=self.first)
        self.assertEqual(released["data"]["released"], claim["id"])

    def test_wait_claim_retries_without_holding_state_lock(self):
        resource = self.resource("shared:build")
        original = self.action("claim", {"roomId": self.first["roomId"], "resources": [resource]},
                               session=self.first)["data"]
        waiter = subprocess.Popen(
            [sys.executable, str(CLI), "--root", str(self.root), "--action", "wait-claim",
             "--request-json", json.dumps({
                 "sessionId": self.second["sessionId"], "roomId": self.first["roomId"],
                 "resources": [resource], "timeoutMs": 5000, "pollMs": 20,
             }, separators=(",", ":"))],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        )
        try:
            time.sleep(0.15)
            self.assertIsNone(waiter.poll(), "wait-claim should still be waiting")
            unrelated = self.action("claim", {
                "roomId": self.first["roomId"], "resources": [self.resource("unrelated")]
            }, session=self.first)["data"]
            self.action("release", {"claimId": original["id"]}, session=self.first)
            stdout, stderr = waiter.communicate(timeout=10)
            self.assertEqual(waiter.returncode, 0, f"{stdout} {stderr}")
            result = json.loads(stdout)["data"]
            self.assertGreaterEqual(result["attempts"], 2)
            expected = dict(resource)
            expected["identity"] = resource["identity"].upper()
            self.assertEqual(result["claim"]["resources"], [expected])
            self.action("release", {"claimId": unrelated["id"]}, session=self.first)
        finally:
            if waiter.poll() is None:
                waiter.kill()
                waiter.wait(timeout=5)
            if waiter.stdout:
                waiter.stdout.close()
            if waiter.stderr:
                waiter.stderr.close()

    def test_wait_claim_timeout_does_not_leave_a_claim(self):
        resource = self.resource("shared:blocked")
        claim = self.action("claim", {"roomId": self.first["roomId"], "resources": [resource]},
                            session=self.first)["data"]
        process, envelope = self.action("wait-claim", {
            "roomId": self.first["roomId"], "resources": [resource], "timeoutMs": 0, "pollMs": 10,
        }, session=self.second, check=False)
        self.assertEqual(process.returncode, 3)
        self.assertEqual(envelope["code"], "Timeout")
        state = self.action("inspect")["data"]["state"]
        self.assertEqual([item["id"] for item in state["claims"]], [claim["id"]])

    def simulate_reboot(self):
        snapshot_path = self.root / "state.json"
        envelope = json.loads(snapshot_path.read_text(encoding="utf-8"))
        envelope["data"]["boot"] = "previous-boot"
        data = json.dumps(envelope["data"], ensure_ascii=False, separators=(",", ":"))
        envelope["sha256"] = hashlib.sha256(data.encode("utf-8")).hexdigest().upper()
        snapshot_path.write_text(json.dumps(envelope, separators=(",", ":")), encoding="utf-8")

    def test_wait_claim_cannot_bypass_boot_reconciliation(self):
        self.simulate_reboot()
        request = {"roomId": self.first["roomId"], "resources": [self.resource("new:work")]}
        for action in ("claim", "wait-claim"):
            with self.subTest(action=action):
                process, failure = self.action(action, request, session=self.first, check=False)
                self.assertEqual((process.returncode, failure["code"]), (5, "Boot"))
        self.assertFalse(self.action("inspect")["data"]["state"]["claims"])

    def test_idle_reboot_can_join_only_for_explicit_recovery(self):
        self.register_fake_target()
        self.action("leave", session=self.second)
        self.action("leave", session=self.first)
        self.simulate_reboot()
        request = {"client": "test", "purpose": "boot recovery", "name": "recovery"}
        process, failure = self.action("join", request, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Boot"))

        joined = self.action("join", {**request, "recoverBoot": True})["data"]
        self.assertTrue(joined["recoveryOnly"])
        before = self.action("inspect")["data"]
        self.assertTrue(before["bootMismatch"])
        claim_request = {"roomId": joined["roomId"], "resources": [self.resource("new:work")]}
        process, failure = self.action("claim", claim_request, session=joined, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Boot"))

        recovered = self.action("recover", {
            "confirm": "RECONCILE", "mode": "verify-stopped",
            "runtimeGeneration": before["state"]["runtime"]["generation"],
        }, session=joined)["data"]
        self.assertTrue(recovered["recovered"])
        self.assertFalse(self.action("inspect")["data"]["bootMismatch"])
        claim = self.action("claim", claim_request, session=joined)["data"]
        self.action("release", {"claimId": claim["id"]}, session=joined)
        self.action("leave", session=joined)

    def test_recovery_join_does_not_replace_existing_owners(self):
        claim = self.action("claim", {
            "roomId": self.first["roomId"], "resources": [self.resource("retained:work")],
        }, session=self.first)["data"]
        self.simulate_reboot()
        process, failure = self.action("join", {
            "client": "test", "purpose": "boot recovery", "name": "recovery", "recoverBoot": True,
        }, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Boot"))
        state = self.action("inspect")["data"]["state"]
        self.assertEqual([item["id"] for item in state["claims"]], [claim["id"]])
        self.assertEqual(len(state["sessions"]), 2)

    def test_recovery_join_still_requires_stopped_adapter_inventory(self):
        target = self.register_fake_target()
        self.action("leave", session=self.second)
        self.action("leave", session=self.first)
        self.simulate_reboot()
        world = pathlib.Path(target["config"]["stateFile"])
        world.write_text("active", encoding="utf-8")
        joined = self.action("join", {
            "client": "test", "purpose": "boot recovery", "name": "recovery", "recoverBoot": True,
        })["data"]
        generation = self.action("inspect")["data"]["state"]["runtime"]["generation"]
        process, failure = self.action("recover", {
            "confirm": "RECONCILE", "mode": "verify-stopped", "runtimeGeneration": generation,
        }, session=joined, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Inventory"))
        inspected = self.action("inspect")["data"]
        self.assertTrue(inspected["bootMismatch"])
        self.assertTrue(inspected["recoveryRequired"])
        self.assertEqual(world.read_text(encoding="utf-8"), "active")

    def test_equal_identity_conflicts_across_resource_kinds(self):
        identical = str(self.root.parent / "cross-kind")
        claim = self.action("claim", {
            "roomId": self.first["roomId"], "resources": [self.resource(identical, kind="key")]
        }, session=self.first)["data"]
        process, envelope = self.action("claim", {
            "roomId": self.first["roomId"], "resources": [self.resource(identical, kind="path")]
        }, session=self.second, check=False)
        self.assertEqual(process.returncode, 3)
        self.assertEqual(envelope["code"], "Conflict")
        self.action("release", {"claimId": claim["id"]}, session=self.first)

    def test_tampered_snapshot_is_rejected(self):
        state_path = self.root / "state.json"
        envelope = json.loads(state_path.read_text(encoding="utf-8"))
        envelope["data"]["revision"] += 1
        state_path.write_text(json.dumps(envelope, separators=(",", ":")), encoding="utf-8")
        process, result = self.action("inspect", check=False)
        self.assertEqual(process.returncode, 5)
        self.assertEqual(result["code"], "State")

    def test_existing_schema_two_checksum_and_json_whitespace_are_preserved(self):
        state_path = self.root / "state.json"
        envelope = json.loads(state_path.read_text(encoding="utf-8"))
        data = json.dumps(envelope["data"], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        checksum = hashlib.sha256(data.encode("utf-8")).hexdigest().upper()
        state_path.write_text(
            '{"schema":2, "sha256":"' + checksum + '", "data": ' + data + ' }',
            encoding="utf-8",
        )
        self.assertEqual(self.action("inspect")["data"]["state"]["sessions"][0]["id"], self.first["sessionId"])

    def test_path_claims_conflict_with_descendants(self):
        parent = self.root.parent / "workspace"
        child = parent / "src"
        first = self.action("claim", {
            "roomId": self.first["roomId"], "resources": [self.resource(str(parent), kind="path")],
        }, session=self.first)["data"]
        process, envelope = self.action("claim", {
            "roomId": self.first["roomId"], "resources": [self.resource(str(child), kind="path")],
        }, session=self.second, check=False)
        self.assertEqual(process.returncode, 3)
        self.assertEqual(envelope["code"], "Conflict")
        self.action("release", {"claimId": first["id"]}, session=self.first)

    def test_root_refuses_to_initialize_nonempty_legacy_directory(self):
        other = self.root.parent / "legacy"
        other.mkdir()
        (other / "old.json").write_text("{}", encoding="utf-8")
        command = [sys.executable, str(CLI), "--root", str(other), "--action", "inspect"]
        process = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(process.returncode, 5)
        self.assertEqual(json.loads(process.stdout)["code"], "State")

    def test_macos_host_identity_uses_hardware_uuid(self):
        spec = importlib.util.spec_from_file_location("resource_room_host_test", CLI)
        coordinator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(coordinator)
        hardware_uuids = iter((
            "A1B2C3D4-E5F6-4789-ABCD-0123456789AB",
            "B1B2C3D4-E5F6-4789-ABCD-0123456789AB",
        ))

        def fake_run(command, **_kwargs):
            output = (
                f'"IOPlatformUUID" = "{next(hardware_uuids)}"'
                if command[0] == "/usr/sbin/ioreg"
                else "{ sec = 1730000000, usec = 0 }"
            )
            return subprocess.CompletedProcess(command, 0, output, "")

        with (
            mock.patch.object(coordinator, "_is_windows", return_value=False),
            mock.patch.object(coordinator.sys, "platform", "darwin"),
            mock.patch.object(coordinator.subprocess, "run", side_effect=fake_run),
        ):
            first = coordinator._host_identity()
            second = coordinator._host_identity()

        self.assertNotEqual(first[0], second[0])
        self.assertEqual(first[1], second[1])

    def test_windows_boot_time_retains_64_bit_uptime(self):
        import ctypes
        import datetime

        spec = importlib.util.spec_from_file_location("resource_room_uptime_test", CLI)
        coordinator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(coordinator)
        elapsed = 60 * 24 * 60 * 60 * 1000
        callback = ctypes.CFUNCTYPE(ctypes.c_ulonglong)(lambda: elapsed)
        tick = ctypes.CFUNCTYPE(ctypes.c_int)(ctypes.cast(callback, ctypes.c_void_p).value)
        library = types.SimpleNamespace(GetTickCount64=tick)
        with (
            mock.patch.object(ctypes, "WinDLL", return_value=library, create=True),
            mock.patch.object(ctypes, "windll", types.SimpleNamespace(kernel32=library), create=True),
        ):
            boot = datetime.datetime.fromisoformat(coordinator._windows_boot_time().replace("Z", "+00:00"))
        age = datetime.datetime.now(datetime.timezone.utc) - boot
        self.assertAlmostEqual(age.total_seconds(), elapsed / 1000, delta=2)

    def test_pinned_adapter_activation_use_and_park(self):
        target = self.register_fake_target()
        queued = self.action("request", {
            "roomId": self.first["roomId"], "targetId": target["id"],
            "fingerprint": target["fingerprint"], "descriptorGeneration": target["generation"],
            "purpose": "test activation",
        }, session=self.first)["data"]
        active = self.action("activate", {"requestId": queued["id"]}, session=self.first)["data"]
        self.assertEqual(active["runtime"]["status"], "running")
        self.assertTrue(active["runtime"]["owned"])
        self.action("release-use", {"useId": active["use"]["id"]}, session=self.first)
        parked = self.action("park", {
            "runtimeGeneration": active["runtime"]["generation"],
        }, session=self.first)["data"]
        self.assertEqual(parked["runtime"]["status"], "stopped")
        self.assertIsNone(parked["runtime"]["targetId"])

    def test_non_python_adapters_are_rejected_before_registration(self):
        for extension in (".ps1", ".sh", ".exe"):
            with self.subTest(extension=extension):
                adapter = self.root.parent / f"unsupported{extension}"
                adapter.write_text("not executable", encoding="utf-8")
                process, failure = self.action("register-adapter", {
                    "name": "unsupported", "path": str(adapter),
                    "sha256": hashlib.sha256(adapter.read_bytes()).hexdigest(),
                }, session=self.first, check=False)
                self.assertEqual(process.returncode, 2)
                self.assertEqual(failure["code"], "Adapter")
        self.assertFalse(self.action("inspect")["data"]["state"]["adapters"])

    def test_fifo_sharing_and_last_participant_shutdown(self):
        target = self.register_fake_target()
        first_request = self.queue(target)
        second_request = self.queue(target, self.second)
        process, failure = self.action("activate", {"requestId": second_request["id"]},
                                       session=self.second, check=False)
        self.assertEqual((process.returncode, failure["code"]), (3, "Queue"))
        first = self.action("activate", {"requestId": first_request["id"]}, session=self.first)["data"]
        second = self.action("activate", {"requestId": second_request["id"]}, session=self.second)["data"]
        self.assertEqual(first["runtime"]["generation"], second["runtime"]["generation"])
        self.assertEqual(len(second["runtime"]["uses"]), 2)
        process, failure = self.action("release-use", {"useId": first["use"]["id"]},
                                       session=self.second, check=False)
        self.assertEqual((process.returncode, failure["code"]), (4, "Owner"))
        self.action("release-use", {"useId": first["use"]["id"]}, session=self.first)
        self.action("leave", session=self.first)
        self.assertTrue(pathlib.Path(target["config"]["stateFile"]).exists())
        self.action("release-use", {"useId": second["use"]["id"]}, session=self.second)
        self.action("leave", session=self.second)
        final = self.action("inspect")["data"]["state"]
        self.assertEqual(final["runtime"]["status"], "stopped")
        self.assertFalse(final["claims"])
        self.assertFalse(pathlib.Path(target["config"]["stateFile"]).exists())

    def test_failed_stop_blocks_switch_to_next_target(self):
        first_target = self.register_fake_target(stop_fails=True)
        second_target = self.register_fake_target(target_id="second-target")
        queued = self.queue(first_target)
        active = self.action("activate", {"requestId": queued["id"]}, session=self.first)["data"]
        next_request = self.queue(second_target, self.second)
        process, failure = self.action("activate", {"requestId": next_request["id"]},
                                       session=self.second, check=False)
        self.assertEqual((process.returncode, failure["code"]), (6, "Busy"))
        self.assertIsNone(self.action("inspect")["data"]["state"]["operation"])
        self.action("release-use", {"useId": active["use"]["id"]}, session=self.first)
        process, failure = self.action("activate", {"requestId": next_request["id"]},
                                       session=self.second, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Adapter"))
        final = self.action("inspect")["data"]["state"]
        self.assertEqual(final["runtime"]["status"], "faulted")
        self.assertEqual(final["operation"]["ownedTargets"], [first_target["id"]])
        self.assertTrue(pathlib.Path(first_target["config"]["stateFile"]).exists())
        self.assertFalse(pathlib.Path(second_target["config"]["stateFile"]).exists())
        self.assertIn("Inspect", [entry["action"] for entry in final["operation"]["results"]])

    def test_changed_adapter_pin_blocks_launch(self):
        target = self.register_fake_target()
        queued = self.queue(target)
        adapter = self.root.parent / f"{target['id']}_adapter.py"
        adapter.write_text(adapter.read_text(encoding="utf-8") + "# changed\n", encoding="utf-8")
        process, failure = self.action("activate", {"requestId": queued["id"]},
                                       session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Adapter"))
        self.assertFalse(pathlib.Path(target["config"]["stateFile"]).exists())
        final = self.action("inspect")["data"]["state"]
        self.assertFalse(final["operation"]["launchAttempts"])

    def test_unowned_running_target_is_not_stopped_during_recovery(self):
        target = self.register_fake_target()
        world = pathlib.Path(target["config"]["stateFile"])
        world.write_text("active", encoding="utf-8")
        queued = self.queue(target)
        process, failure = self.action("activate", {"requestId": queued["id"]},
                                       session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Inventory"))
        operation = self.action("inspect")["data"]["state"]["operation"]
        self.assertFalse(operation["ownedTargets"])
        process, failure = self.action("recover", {
            "confirm": "RECONCILE", "mode": "stop-owned",
            "operationId": operation["id"], "operationGeneration": operation["generation"],
        }, session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Inventory"))
        self.assertEqual(world.read_text(encoding="utf-8"), "active")

    def test_concurrent_processes_cannot_both_claim_exclusively(self):
        processes = []
        try:
            for session in (self.first, self.second):
                processes.append(subprocess.Popen(
                    [sys.executable, str(CLI), "--root", str(self.root), "--action", "claim",
                     "--request-json", json.dumps({
                         **session, "resources": [self.resource("race:claim")],
                     })],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                ))
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=15)
                self.assertFalse(stderr)
                results.append((process.returncode, json.loads(stdout)))
            self.assertEqual(sorted(result[0] for result in results), [0, 3])
            claims = self.action("inspect")["data"]["state"]["claims"]
            self.assertEqual(len(claims), 1)
            winner = next(result["data"] for code, result in results if code == 0)
            self.assertEqual(claims[0]["id"], winner["id"])
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_failed_run_keeps_claims_until_explicit_resource_reconciliation(self):
        script = self.root.parent / "failed_build.py"
        script.write_text("raise SystemExit(9)\n", encoding="utf-8")
        process, failure = self.action("run", {
            "roomId": self.first["roomId"], "scriptPath": str(script),
            "sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "parameters": {},
            "effects": "offline", "resources": [self.resource("failed:build")],
        }, session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (7, "Command"))
        state = self.action("inspect")["data"]["state"]
        operation = state["operation"]
        self.assertEqual([claim["id"] for claim in state["claims"]], operation["claimIds"])
        recovery = {
            "confirm": "RECONCILE", "mode": "verify-stopped",
            "operationId": operation["id"], "operationGeneration": operation["generation"],
        }
        process, failure = self.action("recover", recovery, session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (2, "Invalid"))
        self.action("recover", {**recovery, "resourcesReconciled": True}, session=self.first)
        final = self.action("inspect")["data"]["state"]
        self.assertFalse(final["claims"])
        self.assertIsNone(final["operation"])

    def test_owner_can_release_run_that_failed_before_first_inspection_result(self):
        inspect_failure = self.root.parent / "inspect-failure"
        target = self.register_fake_target(inspect_failure_flag=inspect_failure)
        inspect_failure.touch()
        third = self.action("join", {
            "client": "test", "purpose": "independent claimant", "roomId": self.first["roomId"],
        })["data"]
        peer_claim = self.action("claim", {
            "roomId": third["roomId"], "resources": [self.resource("peer:work")],
        }, session=third)["data"]
        queued = self.queue(target, self.second)
        marker = self.root.parent / "run-marker"
        script = self.root.parent / "run.py"
        script.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n", encoding="utf-8")
        process, failure = self.action("run", {
            "roomId": self.first["roomId"], "scriptPath": str(script),
            "sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "parameters": {},
            "effects": "offline", "resources": [self.resource("reserved:build")],
        }, session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Adapter"))
        before = self.action("inspect")["data"]["state"]
        operation = before["operation"]
        self.assertEqual(operation["phase"], f"Inspect:{target['id']}")
        self.assertEqual(operation["results"], [])
        self.assertFalse(marker.exists())

        recovery = {
            "confirm": "RECONCILE", "mode": "release-unstarted-run",
            "operationId": operation["id"], "operationGeneration": operation["generation"],
        }
        process, failure = self.action("recover", recovery, session=self.second, check=False)
        self.assertEqual((process.returncode, failure["code"]), (4, "Owner"))
        process, failure = self.action(
            "recover", {**recovery, "operationGeneration": operation["generation"] + 1},
            session=self.first, check=False,
        )
        self.assertEqual((process.returncode, failure["code"]), (3, "Generation"))
        self.assertEqual(self.action("inspect")["data"]["state"], before)

        self.action("recover", recovery, session=self.first)
        after = self.action("inspect")["data"]["state"]
        self.assertIsNone(after["operation"])
        self.assertEqual(after["history"], [*before["history"], operation])
        self.assertEqual(after["runtime"], {
            **before["runtime"], "status": "stopped", "generation": before["runtime"]["generation"] + 1,
        })
        self.assertEqual(after["claims"], [peer_claim])
        self.assertEqual(after["requests"], [queued])
        self.assertEqual(after["adapters"], before["adapters"])
        self.assertEqual(after["targets"], before["targets"])
        self.assertEqual(after["events"][:-1], before["events"])
        self.assertEqual(after["events"][-1]["action"], "released-unstarted-run")
        self.assertFalse(marker.exists())

        process, failure = self.action(
            "activate", {"requestId": queued["id"]}, session=self.second, check=False,
        )
        self.assertEqual((process.returncode, failure["code"]), (5, "Adapter"))
        self.assertFalse(pathlib.Path(target["config"]["stateFile"]).exists())

    def test_run_recovery_refuses_postscript_inspect_failure(self):
        marker = self.root.parent / "run-marker"
        target = self.register_fake_target(inspect_failure_flag=marker)
        script = self.root.parent / "run.py"
        script.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n", encoding="utf-8")
        process, failure = self.action("run", {
            "roomId": self.first["roomId"], "scriptPath": str(script),
            "sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "parameters": {},
            "effects": "offline", "resources": [self.resource("reserved:build")],
        }, session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Adapter"))
        before = self.action("inspect")["data"]["state"]
        operation = before["operation"]
        self.assertEqual(operation["phase"], f"Inspect:{target['id']}")
        self.assertEqual([item["action"] for item in operation["results"]], ["Inspect"])
        self.assertTrue(marker.exists())
        process, failure = self.action("recover", {
            "confirm": "RECONCILE", "mode": "release-unstarted-run",
            "operationId": operation["id"], "operationGeneration": operation["generation"],
        }, session=self.first, check=False)
        self.assertEqual((process.returncode, failure["code"]), (5, "Recovery"))
        self.assertEqual(self.action("inspect")["data"]["state"], before)

    def test_cli_json_is_utf8_independent_of_console_encoding(self):
        environment = dict(os.environ, PYTHONIOENCODING="ascii")
        process = subprocess.run(
            [sys.executable, str(CLI), "--root", str(self.root), "--action", "message",
             "--request-json", json.dumps({
                 "sessionId": self.first["sessionId"], "roomId": self.first["roomId"],
                 "text": "caf\u00e9 \u4e2d\u6587", "data": {},
             })],
            capture_output=True, encoding="utf-8", env=environment, timeout=15,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["data"]["text"], "caf\u00e9 \u4e2d\u6587")

    def test_prepared_candidate_freezes_runs_thaws_and_releases(self):
        target = self.register_fake_target()
        barrier_resources = [self.resource("candidate:checkout")]
        barrier = self.action("cohort", {
            "roomId": self.first["roomId"], "expectedGeneration": 0, "candidate": "candidate-v1",
            "cohort": [self.first["sessionId"], self.second["sessionId"]], "resources": barrier_resources,
        }, session=self.first)["data"]
        base = {"roomId": self.first["roomId"], "generation": barrier["generation"], "candidate": "candidate-v1"}
        self.action("ready", base, session=self.first)
        self.action("ready", base, session=self.second)
        queued = self.action("request", {
            "roomId": self.first["roomId"], "targetId": target["id"], "fingerprint": target["fingerprint"],
            "descriptorGeneration": target["generation"], "purpose": "prepared candidate",
            "barrierGeneration": barrier["generation"], "candidate": "candidate-v1",
        }, session=self.first)["data"]
        prepared = self.action("prepare", {"requestId": queued["id"]}, session=self.first)["data"]
        turn = prepared["turn"]
        frozen = {**base, "turnId": turn["id"], "turnGeneration": turn["generation"]}
        self.action("freeze", frozen, session=self.first)
        script = self.root.parent / "build.py"
        script.write_text(
            "import json, sys\n"
            "json.load(sys.stdin)\n"
            "print('built')\n",
            encoding="utf-8",
        )
        result = self.action("run", {
            "roomId": self.first["roomId"], "scriptPath": str(script),
            "sha256": hashlib.sha256(script.read_bytes()).hexdigest().upper(),
            "parameters": {}, "effects": "offline", "resources": barrier_resources,
            "barrierGeneration": barrier["generation"], "candidate": "candidate-v1",
            "turnId": turn["id"], "turnGeneration": turn["generation"],
        }, session=self.first)["data"]
        self.assertEqual(result["output"], ["built"])
        self.action("thaw", frozen, session=self.first)
        self.action("release-turn", {
            "turnId": turn["id"], "turnGeneration": turn["generation"],
        }, session=self.first)
        final = self.action("inspect")["data"]["state"]
        self.assertIsNone(final["runtime"]["turn"])
        self.assertIsNone(final["rooms"][0]["barrier"])
        self.assertFalse(final["claims"])

    def test_recovery_stops_only_an_established_partial_start(self):
        target = self.register_fake_target(start_unknown=True)
        queued = self.action("request", {
            "roomId": self.first["roomId"], "targetId": target["id"],
            "fingerprint": target["fingerprint"], "descriptorGeneration": target["generation"],
            "purpose": "partial start recovery",
        }, session=self.first)["data"]
        process, failure = self.action("activate", {"requestId": queued["id"]}, session=self.first, check=False)
        self.assertEqual(process.returncode, 5)
        self.assertEqual(failure["code"], "Lifecycle")
        failed_state = self.action("inspect")["data"]["state"]
        self.assertEqual(failed_state["runtime"]["status"], "faulted")
        operation = failed_state["operation"]
        self.assertEqual(operation["ownedTargets"], [target["id"]])
        recovered = self.action("recover", {
            "confirm": "RECONCILE", "mode": "stop-owned",
            "operationId": operation["id"], "operationGeneration": operation["generation"],
        }, session=self.first)["data"]
        self.assertTrue(recovered["recovered"])
        self.assertEqual(recovered["runtime"]["status"], "stopped")
        final_state = self.action("inspect")["data"]["state"]
        self.assertIsNone(final_state["operation"])
        self.assertFalse(final_state["claims"])

    def test_stopped_descriptor_supersession_preserves_resources(self):
        target = self.register_fake_target()
        replacement = {
            **{key: target[key] for key in ("id", "adapter", "resources")},
            "fingerprint": "target-v2",
            "config": target["config"],
            "state": {},
        }
        result = self.action("supersede-target", {
            "targetId": target["id"], "fingerprint": target["fingerprint"],
            "descriptorGeneration": target["generation"], "target": replacement,
        }, session=self.first)["data"]
        self.assertEqual(result["target"]["fingerprint"], "target-v2")
        self.assertGreater(result["target"]["generation"], target["generation"])
        final = self.action("inspect")["data"]["state"]
        self.assertEqual(len(final["targets"]), 1)
        self.assertEqual(final["targets"][0]["fingerprint"], "target-v2")
        self.assertEqual(final["history"][0]["kind"], "descriptor-supersession")

    def test_adapter_rebind_is_stopped_only_and_atomic_for_the_whole_pin(self):
        old_called = self.root.parent / "old-called"
        inspected = self.root.parent / "rebind-inspected"
        running = self.root.parent / "running"
        old = self.root.parent / "broken_adapter.py"
        old.write_text(
            f"import pathlib\npathlib.Path({str(old_called)!r}).touch()\nraise RuntimeError('broken pin')\n",
            encoding="utf-8",
        )
        new = self.root.parent / "replacement_adapter.py"
        new.write_text(
            "import json, pathlib, sys\n"
            "r = json.load(sys.stdin)\n"
            "old, new = r['originalTarget'], r['target']\n"
            "assert r['action'] == 'InspectRebind'\n"
            "assert old['id'] == new['id'] and old['resources'] == new['resources']\n"
            "assert old['config'] == new['config'] == {'identity': old['id']}\n"
            "assert old['adapter'] == 'broken' and new['adapter'] == 'replacement'\n"
            "assert not old['state'] and not new['state']\n"
            f"with pathlib.Path({str(inspected)!r}).open('a', encoding='utf-8') as f:\n"
            "    print(old['id'], file=f)\n"
            f"active = old['id'] == 'runtime-b' and pathlib.Path({str(running)!r}).exists()\n"
            "print(json.dumps({'status': 'unknown' if active else 'stopped', 'ready': False,\n"
            "                  'blockers': ['runtime active'] if active else [], 'state': {}}))\n",
            encoding="utf-8",
        )
        pins = {}
        for name, script in (("broken", old), ("replacement", new)):
            pins[name] = hashlib.sha256(script.read_bytes()).hexdigest().upper()
            self.action("register-adapter", {
                "name": name, "path": str(script), "sha256": pins[name],
            }, session=self.first)

        targets = [self.action("register-target", {"target": {
            "id": name, "fingerprint": f"{name}-v1", "adapter": "broken",
            "resources": [self.resource(name, mode="shared")], "config": {"identity": name},
            "state": {},
        }}, session=self.first)["data"] for name in ("runtime-a", "runtime-b")]
        peer = self.register_fake_target()
        peer_request = self.queue(peer, session=self.second)
        third = self.action("join", {"client": "test", "purpose": "peer claim", "name": "other room"})["data"]
        claim = self.action("claim", {"roomId": third["roomId"], "resources": [
            self.resource("unrelated:peer"),
        ]}, session=third)["data"]
        request = {
            "protocolVersion": 1,
            "confirm": "REBIND_STOPPED",
            "oldAdapter": {"name": "broken", "sha256": pins["broken"]},
            "newAdapter": {"name": "replacement", "sha256": pins["replacement"]},
            "targets": [{
                "targetId": target["id"], "fingerprint": target["fingerprint"],
                "descriptorGeneration": target["generation"],
                "target": {
                    "id": target["id"], "fingerprint": f"{target['id']}-v2",
                    "adapter": "replacement", "resources": target["resources"], "config": target["config"], "state": {},
                },
            } for target in targets],
        }
        state_file = self.root / "state.json"
        before = state_file.read_bytes()
        process, error = self.action("rebind-adapter", {**request, "targets": request["targets"][:1]},
                                     session=self.first, check=False)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(error["code"], "Conflict")
        self.assertEqual(state_file.read_bytes(), before)
        self.assertFalse(inspected.exists())

        altered = dict(request["targets"][0])
        altered["target"] = {**altered["target"], "resources": [self.resource("new:scope")]}
        process, error = self.action("rebind-adapter", {**request, "targets": [altered, request["targets"][1]]},
                                     session=self.first, check=False)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(error["code"], "Conflict")
        self.assertEqual(state_file.read_bytes(), before)
        self.assertFalse(inspected.exists())

        running.touch()
        process, error = self.action("rebind-adapter", request, session=self.first, check=False)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(error["code"], "Lifecycle")
        self.assertEqual(inspected.read_text(encoding="utf-8").splitlines(), ["runtime-a", "runtime-b"])
        self.assertEqual(state_file.read_bytes(), before)
        self.assertFalse(old_called.exists())

        running.unlink()
        self.action("rebind-adapter", request, session=self.first)
        self.assertFalse(old_called.exists())
        final = self.action("inspect")["data"]["state"]
        previous = json.loads(before)["data"]
        self.assertEqual(final["adapters"], previous["adapters"])
        self.assertEqual(final["claims"], [claim])
        self.assertEqual(final["requests"], [peer_request])
        self.assertEqual(final["runtime"], previous["runtime"])
        self.assertIn(peer, final["targets"])
        for target in targets:
            current = next(item for item in final["targets"] if item["id"] == target["id"])
            self.assertEqual(current["adapter"], "replacement")
            self.assertEqual(current["fingerprint"], f"{target['id']}-v2")
            self.assertEqual(current["resources"], target["resources"])
            self.assertGreater(current["generation"], target["generation"])
            self.assertTrue(any(item["oldTarget"] == target for item in final["history"]))

    def test_run_invokes_pinned_python_script_with_json_parameters(self):
        script = self.root.parent / "run.py"
        script.write_text(
            "import json, sys\n"
            "parameters = json.load(sys.stdin)\n"
            "print(parameters['message'])\n",
            encoding="utf-8",
        )
        script_hash = hashlib.sha256(script.read_bytes()).hexdigest().upper()
        result = self.action("run", {
            "roomId": self.first["roomId"], "scriptPath": str(script), "sha256": script_hash,
            "parameters": {"message": "portable"}, "effects": "offline",
            "resources": [self.resource("script:test")],
        }, session=self.first)["data"]
        self.assertEqual(result["output"], ["portable"])
        self.assertEqual(result["runtimeGeneration"], 0)


if __name__ == "__main__":
    unittest.main()
