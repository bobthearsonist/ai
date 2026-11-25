#!/usr/bin/env python3
"""Cross-platform resource-room coordinator CLI."""

from __future__ import annotations

import argparse
import contextlib
import datetime as _datetime
import hashlib
import json
import os
import pathlib
import platform
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import stat
import unicodedata
import uuid
from typing import Any, Callable, Iterator


class RoomError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 2) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def fail(code: str, message: str, exit_code: int = 2) -> None:
    raise RoomError(code, message, exit_code)


def now() -> str:
    return _datetime.datetime.now(_datetime.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def process_started(pid: int | None = None) -> str:
    pid = os.getpid() if pid is None else pid
    try:
        if _is_windows():
            import ctypes
            from ctypes import wintypes

            class FileTime(ctypes.Structure):
                _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.GetProcessTimes.argtypes = (
                wintypes.HANDLE, ctypes.POINTER(FileTime), ctypes.POINTER(FileTime),
                ctypes.POINTER(FileTime), ctypes.POINTER(FileTime),
            )
            kernel32.GetProcessTimes.restype = wintypes.BOOL
            created, exited, kernel, user = FileTime(), FileTime(), FileTime(), FileTime()
            if not kernel32.GetProcessTimes(
                kernel32.GetCurrentProcess(), ctypes.byref(created), ctypes.byref(exited),
                ctypes.byref(kernel), ctypes.byref(user),
            ):
                raise OSError(ctypes.get_last_error(), "GetProcessTimes failed")
            ticks = (created.high << 32) | created.low
            stamp = _datetime.datetime.fromtimestamp((ticks - 116444736000000000) / 10_000_000, _datetime.timezone.utc)
        elif sys.platform.startswith("linux"):
            stat_text = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
            fields = stat_text[stat_text.rfind(")") + 2:].split()
            boot_epoch = int(next(line.split()[1] for line in pathlib.Path("/proc/stat").read_text(encoding="ascii").splitlines() if line.startswith("btime ")))
            ticks_per_second = os.sysconf("SC_CLK_TCK")
            stamp = _datetime.datetime.fromtimestamp(boot_epoch + int(fields[19]) / ticks_per_second, _datetime.timezone.utc)
        elif sys.platform == "darwin":
            value = subprocess.run(
                ["/bin/ps", "-o", "lstart=", "-p", str(pid)], check=True,
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            stamp = _datetime.datetime.strptime(value, "%a %b %d %H:%M:%S %Y").astimezone(_datetime.timezone.utc)
        else:
            raise OSError(f"unsupported platform {platform.system()}")
    except (OSError, ValueError, IndexError, StopIteration, subprocess.SubprocessError) as error:
        fail("Host", f"Cannot establish process start identity: {error}", 5)
    return stamp.isoformat(timespec="microseconds").replace("+00:00", "Z")


def compact_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as error:
        fail("Invalid", f"Value is not JSON-safe: {error}")


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest().upper()


def new_id() -> str:
    return str(uuid.uuid4())


def require_map(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("Invalid", f"{name} must be a JSON object.")
    return value


def required(value: dict[str, Any], name: str) -> Any:
    if name not in value or value[name] is None:
        fail("Invalid", f"Missing {name}.")
    return value[name]


def text(value: dict[str, Any], name: str) -> str:
    result = required(value, name)
    if not isinstance(result, str) or not result.strip() or len(result) > 4096:
        fail("Invalid", f"{name} must be a nonempty string (maximum 4096 characters).")
    return result


def assert_id(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) or ".." in value:
        fail("Invalid", "Identifiers must be 1-128 ASCII letters, numbers, dots, underscores or hyphens, without traversal.")


def assert_target_id(value: str) -> None:
    if (not value or len(value) > 4096 or value != value.strip()
            or re.search(r"[\x00-\x1f]", value)
            or re.search(r"(^|[\\/])\.\.?($|[\\/])", value)):
        fail("Invalid", "Target IDs must be nonempty opaque strings without control characters, surrounding whitespace or traversal segments.")


def assert_generation(actual: Any, expected: Any) -> None:
    if isinstance(expected, bool) or not isinstance(expected, int):
        fail("Invalid", "An explicit integer generation is required.")
    if actual != expected:
        fail("Generation", f"Expected generation {expected}; current generation is {actual}.", 3)


def _is_windows() -> bool:
    return os.name == "nt"


def _canonical_path(raw: str, *, must_exist: bool = False, file: bool = False) -> pathlib.Path:
    if not isinstance(raw, str) or not raw or re.search(r"[\x00-\x1f]", raw):
        fail("Path", "An absolute local path is required.")
    path = pathlib.Path(raw)
    if not path.is_absolute():
        fail("Path", "Use an absolute local path.")
    if _is_windows():
        if not re.match(r"^[A-Za-z]:\\", raw) or "/" in raw or re.search(r'[*?"<>|]', raw):
            fail("Path", "Use a fully qualified local drive path with backslashes, without wildcards or alternate streams.")
        if re.search(r"^[A-Za-z]:\\", raw) is None:
            fail("Path", "UNC and device paths are unsupported.")
        for part in raw[3:].split("\\"):
            if (part in (".", "..") or part.endswith((" ", "."))
                    or re.match(r"(?i)^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)", part)):
                fail("Path", f"Ambiguous or traversal path component: {part}")
        if len(raw) >= 2 and raw[1] == ":":
            drive_type = _windows_drive_type(raw[:3])
            if drive_type != 3:
                fail("Path", "Coordination and resource paths must use a local fixed drive, not network/removable storage.")
    elif raw.startswith("//"):
        fail("Path", "Network paths are unsupported.")
    else:
        if any(part in (".", "..") for part in re.split(r"[/\\]", raw)):
            fail("Path", "Traversal path components are unsupported.")

    try:
        _assert_no_symlink_ancestors(path)
        full = path.resolve(strict=False)
    except OSError as error:
        fail("Path", f"Cannot resolve path: {error}")
    if must_exist and not full.exists():
        fail("Path", f"Path does not exist: {full}")
    _assert_local_filesystem(full)
    if file and (not full.is_file() or full.is_symlink()):
        fail("Path", f"Expected an existing regular file: {full}")
    if file and full.exists():
        try:
            if full.stat().st_nlink > 1:
                fail("Path", "Hard-linked files are ambiguous resource identities.")
        except OSError as error:
            fail("Path", f"Cannot establish file identity: {error}")
    return full


def _assert_local_filesystem(path: pathlib.Path) -> None:
    probe = path
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    if sys.platform.startswith("linux"):
        network_types = {
            "9p", "afs", "ceph", "cifs", "davfs", "fuse.sshfs", "glusterfs", "nfs", "nfs4", "smb3",
        }
        try:
            best: tuple[int, str] = (-1, "")
            for line in pathlib.Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
                fields = line.split()
                separator = fields.index("-")
                mountpoint = fields[4].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
                mount = pathlib.Path(mountpoint)
                try:
                    if probe == mount or mount in probe.parents:
                        if len(str(mount)) > best[0]:
                            best = (len(str(mount)), fields[separator + 1])
                except ValueError:
                    continue
        except (OSError, ValueError, IndexError) as error:
            fail("Path", f"Cannot determine the local filesystem for {path}: {error}")
        if best[0] < 0:
            fail("Path", f"Cannot determine the mounted filesystem for {path}.")
        if best[1].casefold() in network_types:
            fail("Path", "Coordination state and resources must use local storage, not a network filesystem.")
    elif sys.platform == "darwin":
        try:
            fs_type = subprocess.run(
                ["/usr/bin/stat", "-f", "%T", str(probe)], check=True,
                capture_output=True, text=True, timeout=5,
            ).stdout.strip().casefold()
        except (OSError, subprocess.SubprocessError) as error:
            fail("Path", f"Cannot determine the local filesystem for {path}: {error}")
        if fs_type in {"nfs", "smbfs", "webdav", "afpfs", "sshfs"}:
            fail("Path", "Coordination state and resources must use local storage, not a network filesystem.")


def _windows_drive_type(root: str) -> int:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetDriveTypeW.argtypes = (ctypes.c_wchar_p,)
    kernel32.GetDriveTypeW.restype = ctypes.c_uint
    return int(kernel32.GetDriveTypeW(root))


def _assert_no_symlink_ancestors(path: pathlib.Path) -> None:
    current = path
    while True:
        try:
            if current.exists() or current.is_symlink():
                if current.is_symlink():
                    fail("Path", f"Symbolic links/reparse points are unsupported: {current}")
                if _is_windows():
                    import ctypes

                    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                    kernel32.GetFileAttributesW.argtypes = (ctypes.c_wchar_p,)
                    kernel32.GetFileAttributesW.restype = ctypes.c_uint
                    attrs = kernel32.GetFileAttributesW(str(current))
                    if attrs != 0xFFFFFFFF and attrs & 0x400:
                        fail("Path", f"Symbolic links/reparse points are unsupported: {current}")
        except OSError as error:
            fail("Path", f"Cannot safely inspect path ancestor {current}: {error}")
        if current.parent == current:
            break
        current = current.parent


def _safe_resource_path(raw: str) -> pathlib.Path:
    full = _canonical_path(raw)
    if not full.is_dir():
        if full.is_file():
            try:
                if full.stat().st_nlink > 1:
                    fail("Path", "Hard-linked files are ambiguous resource identities.")
            except OSError as error:
                fail("Path", f"Cannot establish file identity: {error}")
        return full
    pending = [full]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    child = pathlib.Path(entry.path)
                    if entry.is_symlink():
                        fail("Path", f"A subtree claim cannot traverse a symbolic link/reparse descendant: {child}")
                    if _is_windows():
                        import ctypes

                        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                        kernel32.GetFileAttributesW.argtypes = (ctypes.c_wchar_p,)
                        kernel32.GetFileAttributesW.restype = ctypes.c_uint
                        attrs = kernel32.GetFileAttributesW(str(child))
                        if attrs != 0xFFFFFFFF and attrs & 0x400:
                            fail("Path", f"A subtree claim cannot traverse a symbolic link/reparse descendant: {child}")
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(child)
                    elif entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_nlink > 1:
                        fail("Path", f"A hard-linked descendant makes this subtree ambiguous: {child}")
        except RoomError:
            raise
        except OSError as error:
            fail("Path", f"Cannot establish an alias-free resource subtree {full}: {error}")
    return full


def _host_identity() -> tuple[str, str]:
    if _is_windows():
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as key:
                machine, _ = winreg.QueryValueEx(key, "MachineGuid")
        except OSError as error:
            fail("Host", f"Cannot obtain the Windows machine identity: {error}", 5)
        host = digest(f"{machine}|{os.environ.get('COMPUTERNAME', socket.gethostname())}")
        # A Windows state written by the former coordinator stores WMI's boot
        # timestamp. Reuse it after verifying the current boot within tolerance.
        boot = _windows_boot_time()
        return host, boot
    if sys.platform.startswith("linux"):
        try:
            machine = pathlib.Path("/etc/machine-id").read_text(encoding="ascii").strip()
            boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
        except OSError as error:
            fail("Host", f"Cannot obtain the Linux host/boot identity: {error}", 5)
        return digest(f"{machine}|{socket.gethostname()}"), boot
    if sys.platform == "darwin":
        try:
            platform_info = subprocess.run(
                ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                check=True, capture_output=True, text=True, timeout=5,
            ).stdout
            platform_uuid = re.search(r'"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"', platform_info)
            if platform_uuid is None:
                fail("Host", "Cannot obtain the macOS hardware UUID.", 5)
            boot_seconds = int(subprocess.run(
                ["sysctl", "-n", "kern.boottime"], check=True, capture_output=True, text=True, timeout=5
            ).stdout.split("sec = ", 1)[1].split(",", 1)[0])
        except (OSError, subprocess.SubprocessError, IndexError, ValueError) as error:
            fail("Host", f"Cannot obtain the macOS host/boot identity: {error}", 5)
        return digest(f"{platform_uuid.group(1)}|{socket.gethostname()}"), str(boot_seconds)
    fail("Unsupported", f"Unsupported platform: {platform.system()}")


def _windows_boot_time() -> str:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetTickCount64.argtypes = ()
    kernel32.GetTickCount64.restype = ctypes.c_ulonglong
    uptime_ms = kernel32.GetTickCount64()
    boot = _datetime.datetime.now(_datetime.timezone.utc) - _datetime.timedelta(milliseconds=uptime_ms)
    return boot.isoformat(timespec="seconds").replace("+00:00", "Z")


def _same_boot(saved: str, current: str) -> bool:
    if saved == current:
        return True
    if _is_windows():
        try:
            old = _datetime.datetime.fromisoformat(saved.replace("Z", "+00:00"))
            new = _datetime.datetime.fromisoformat(current.replace("Z", "+00:00"))
            return abs((old - new).total_seconds()) <= 120
        except ValueError:
            return False
    return False


def _skip_ws(source: str, index: int) -> int:
    while index < len(source) and source[index] in " \t\r\n":
        index += 1
    return index


def _raw_member(source: str, name: str) -> str:
    """Return a JSON object's property's original bytes for legacy checksum validation."""
    decoder = json.JSONDecoder()
    index = _skip_ws(source, 0)
    if index >= len(source) or source[index] != "{":
        fail("State", "Malformed snapshot envelope.", 5)
    index += 1
    while True:
        index = _skip_ws(source, index)
        if index >= len(source) or source[index] == "}":
            break
        key, index = decoder.raw_decode(source, index)
        index = _skip_ws(source, index)
        if index >= len(source) or source[index] != ":":
            fail("State", "Malformed snapshot envelope.", 5)
        start = _skip_ws(source, index + 1)
        _, end = decoder.raw_decode(source, start)
        if key == name:
            return source[start:end]
        index = _skip_ws(source, end)
        if index < len(source) and source[index] == ",":
            index += 1
        else:
            break
    fail("State", f"Missing snapshot.{name}.", 5)


def _lock_file(path: pathlib.Path, *, wait_ms: int = 2000) -> tuple[Any, bool]:
    """Open and exclusively lock one persistent lock file; never unlink it."""
    _canonical_path(str(path))
    created = False
    deadline = time.monotonic() + wait_ms / 1000
    if _is_windows():
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.argtypes = (
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        )
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        create_new = 1
        open_always = 4
        invalid = wintypes.HANDLE(-1).value
        handle = kernel32.CreateFileW(str(path), 0xC0000000, 0, None, create_new, 0x80 | 0x00200000, None)
        if handle == invalid:
            error = ctypes.get_last_error()
            if error == 80:
                handle = kernel32.CreateFileW(str(path), 0xC0000000, 0, None, open_always, 0x80 | 0x00200000, None)
            else:
                fail("Path", f"Cannot safely open lock file {path} (Windows error {error}).")
        else:
            created = True
        while handle == invalid:
            error = ctypes.get_last_error()
            if error != 32 or time.monotonic() >= deadline:
                fail("Busy", f"Exclusive lock is held: {path}. Retry; never delete lock files.", 6)
            time.sleep(0.025)
            handle = kernel32.CreateFileW(str(path), 0xC0000000, 0, None, open_always, 0x80 | 0x00200000, None)
        return _WindowsLock(handle, path, kernel32), created

    import fcntl

    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        try:
            fd = os.open(path, flags, 0o600)
            created = True
        except FileExistsError:
            flags &= ~os.O_EXCL
            fd = os.open(path, flags, 0o600)
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink > 1:
            fail("Path", f"Lock must be a regular file: {path}.")
    except OSError as error:
        fail("Path", f"Cannot safely open lock file {path}: {error}")
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return _PosixLock(fd), created
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                fail("Busy", f"Exclusive lock is held: {path}. Retry; never delete lock files.", 6)
            time.sleep(0.025)


class _PosixLock:
    def __init__(self, fd: int) -> None:
        self.fd = fd

    def write(self, data: bytes) -> None:
        os.ftruncate(self.fd, 0)
        os.lseek(self.fd, 0, os.SEEK_SET)
        os.write(self.fd, data)
        os.fsync(self.fd)

    def close(self) -> None:
        import fcntl

        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


class _WindowsLock:
    def __init__(self, handle: Any, path: pathlib.Path, kernel32: Any) -> None:
        self.handle = handle
        self.path = path
        self.kernel32 = kernel32
        import ctypes
        from ctypes import wintypes

        self.kernel32.SetFilePointerEx.argtypes = (
            wintypes.HANDLE, ctypes.c_longlong, ctypes.POINTER(ctypes.c_longlong), wintypes.DWORD,
        )
        self.kernel32.SetFilePointerEx.restype = wintypes.BOOL
        self.kernel32.SetEndOfFile.argtypes = (wintypes.HANDLE,)
        self.kernel32.SetEndOfFile.restype = wintypes.BOOL
        self.kernel32.WriteFile.argtypes = (
            wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID,
        )
        self.kernel32.WriteFile.restype = wintypes.BOOL
        self.kernel32.FlushFileBuffers.argtypes = (wintypes.HANDLE,)
        self.kernel32.FlushFileBuffers.restype = wintypes.BOOL

    def write(self, data: bytes) -> None:
        import ctypes
        from ctypes import wintypes

        if not self.kernel32.SetFilePointerEx(self.handle, 0, None, 0) or not self.kernel32.SetEndOfFile(self.handle):
            fail("State", f"Cannot truncate lock owner metadata for {self.path}.", 5)
        written = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(data)
        if not self.kernel32.WriteFile(self.handle, buffer, len(data), ctypes.byref(written), None):
            fail("State", f"Cannot write lock owner metadata for {self.path}.", 5)
        self.kernel32.FlushFileBuffers(self.handle)

    def close(self) -> None:
        self.kernel32.CloseHandle(self.handle)


def _lock_owner(lock: Any, action: str, session_id: str) -> None:
    payload = {
        "token": new_id(),
        "action": action,
        "sessionId": session_id,
        "pid": os.getpid(),
        "processStarted": process_started(),
        "acquired": now(),
    }
    lock.write(compact_json(payload).encode("utf-8"))


def _new_state(root: pathlib.Path, host: str, boot: str) -> dict[str, Any]:
    return {
        "schema": 2,
        "root": str(root).upper() if _is_windows() else str(root),
        "host": host,
        "boot": boot,
        "revision": 0,
        "sequence": 0,
        "operationGeneration": 0,
        "targetGeneration": 0,
        "sessions": [],
        "rooms": [],
        "claims": [],
        "adapters": [],
        "targets": [],
        "requests": [],
        "records": [],
        "messages": [],
        "operation": None,
        "history": [],
        "events": [],
        "runtime": {
            "status": "stopped",
            "targetId": None,
            "fingerprint": None,
            "descriptorGeneration": 0,
            "generation": 0,
            "owner": None,
            "owned": False,
            "participants": [],
            "turn": None,
            "uses": [],
        },
    }


class RoomStore:
    def __init__(self, root: pathlib.Path, host: str, boot: str, action: str, session_id: str) -> None:
        self.root = root
        self.host = host
        self.boot = boot
        self.action = action
        self.session_id = session_id

    def _read(self, lock_created: bool) -> dict[str, Any]:
        state_path = self.root / "state.json"
        _canonical_path(str(state_path))
        if not state_path.exists():
            if not lock_created:
                fail("State", "State is missing from an initialized root. Do not reset or delete ownership.", 5)
            other = [p for p in self.root.iterdir() if p.name != "state.lock"]
            if other:
                fail("State", "Refusing initialization of a nonempty/legacy root.", 5)
            return _new_state(self.root, self.host, self.boot)
        try:
            raw = state_path.read_text(encoding="utf-8")
            envelope = json.loads(raw)
            require_map(envelope, "snapshot")
            if required(envelope, "schema") != 2:
                fail("Schema", "Unsupported snapshot schema.", 5)
            state = require_map(required(envelope, "data"), "snapshot.data")
            if text(envelope, "sha256") != digest(_raw_member(raw, "data")):
                fail("State", "Snapshot integrity check failed; preserve it for reconciliation.", 5)
            self._validate_state(state)
            canonical_root = str(self.root).upper() if _is_windows() else str(self.root)
            if state["root"] != canonical_root:
                fail("Root", "Snapshot belongs to another root.", 5)
            if state["host"] != self.host:
                fail("Host", "Snapshot belongs to another host.", 5)
            return state
        except RoomError:
            raise
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            fail("State", f"Malformed state: {error}", 5)

    def _validate_state(self, state: dict[str, Any]) -> None:
        required_fields = (
            "schema", "root", "host", "boot", "revision", "sequence", "operationGeneration",
            "targetGeneration", "sessions", "rooms", "claims", "adapters", "targets", "requests",
            "history", "events", "runtime", "records", "messages",
        )
        for field in required_fields:
            required(state, field)
        if "operation" not in state:
            fail("Schema", "Unsupported state schema.", 5)
        if state["schema"] != 2:
            fail("Schema", "Unsupported state schema.", 5)
        for field in ("sessions", "rooms", "claims", "adapters", "targets", "requests", "history", "events", "records", "messages"):
            if not isinstance(state[field], list):
                fail("State", f"Invalid state array: {field}", 5)
        for field in ("revision", "sequence", "operationGeneration", "targetGeneration"):
            if isinstance(state[field], bool) or not isinstance(state[field], int) or state[field] < 0:
                fail("State", f"Invalid state counter: {field}", 5)
        runtime = require_map(state["runtime"], "runtime")
        if runtime.get("status") not in ("stopped", "running", "faulted") or not isinstance(runtime.get("uses"), list):
            fail("State", "Invalid runtime state.", 5)
        self._validate_ids(state)

    def _validate_ids(self, state: dict[str, Any]) -> None:
        for collection in ("sessions", "rooms", "claims", "requests", "events", "records", "messages"):
            ids: set[str] = set()
            for record in state[collection]:
                require_map(record, collection)
                ident = text(record, "id")
                assert_id(ident)
                if ident in ids:
                    fail("State", f"Invalid/duplicate {collection} ID.", 5)
                ids.add(ident)
        sessions = {record["id"] for record in state["sessions"]}
        rooms = {record["id"] for record in state["rooms"]}
        claims = {record["id"]: record for record in state["claims"]}
        for item in state["sessions"]:
            self._record(item, "session", ("client", "purpose", "joined", "left"))
            if not isinstance(item["left"], bool):
                fail("State", "Invalid session departure flag.", 5)
            client_session = item.get("clientSession")
            if "clientSession" in item and (not isinstance(client_session, str) or not client_session.strip()):
                fail("State", "Invalid session clientSession.", 5)
        room_keys: set[str] = set()
        for room in state["rooms"]:
            self._record(room, "room", ("owner", "members", "generation", "barrier"))
            if room["owner"] not in sessions or not isinstance(room["members"], list) or not self._integer(room["generation"]):
                fail("State", "Invalid room ownership/generation.", 5)
            if any(member not in sessions for member in room["members"]):
                fail("State", "Room refers to a missing session.", 5)
            if "roomKey" in room:
                key = room["roomKey"]
                if (not isinstance(key, str) or not key or len(key) > 4096 or key != key.strip()
                        or re.search(r"[\x00-\x1f]", key)
                        or key != unicodedata.normalize("NFC", key).upper() or key in room_keys):
                    fail("State", "Invalid immutable room key.", 5)
                room_keys.add(key)
            barrier = room["barrier"]
            if barrier is not None:
                self._record(barrier, "barrier", (
                    "generation", "candidate", "cohort", "resources", "ready", "dirty", "frozen",
                    "owner", "claimId", "participantClaimIds",
                ))
                if (barrier["generation"] != room["generation"] or not isinstance(barrier["cohort"], list)
                        or not isinstance(barrier["ready"], list) or not isinstance(barrier["dirty"], bool)
                        or not isinstance(barrier["frozen"], bool) or barrier["owner"] not in sessions
                        or not isinstance(barrier["participantClaimIds"], list)):
                    fail("State", "Invalid stored barrier.", 5)
                if any(member not in room["members"] for member in barrier["cohort"]):
                    fail("State", "Barrier refers to a nonmember.", 5)
                if any(member not in barrier["cohort"] for member in barrier["ready"]):
                    fail("State", "Readiness refers to a nonparticipant.", 5)
                self._validate_resources(barrier["resources"])
                for claim_id in barrier["participantClaimIds"]:
                    participant = claims.get(claim_id)
                    if (not barrier["frozen"] or participant is None or participant["kind"] != "manual"
                            or participant["owner"] not in barrier["cohort"] or participant["roomId"] != room["id"]
                            or participant.get("suspendedBy") is None
                            or participant["suspendedBy"].get("freezeClaimId") != barrier["claimId"]):
                        fail("State", "Invalid frozen participant claim.", 5)
        for claim in state["claims"]:
            self._record(claim, "claim", ("owner", "roomId", "kind", "resources", "created", "suspendedBy"))
            kind = claim["kind"]
            if (kind not in ("manual", "freeze", "runtime", "operation", "turn")
                    or (kind != "runtime" and claim["owner"] not in sessions)
                    or (kind == "runtime" and (
                        claim["owner"] is not None or claim.get("targetId") != state["runtime"].get("targetId")
                    ))
                    or (claim["roomId"] and claim["roomId"] not in rooms)):
                fail("State", "Invalid stored claim ownership/kind.", 5)
            self._validate_resources(claim["resources"])
            suspended = claim.get("suspendedBy")
            if suspended is not None:
                self._record(suspended, "claim.suspendedBy", ("roomId", "generation", "freezeClaimId"))
                associated_room = next((item for item in state["rooms"] if item["id"] == suspended["roomId"]), None)
                barrier = associated_room.get("barrier") if associated_room else None
                if (kind != "manual" or barrier is None or not barrier["frozen"]
                        or barrier["generation"] != suspended["generation"]
                        or claim["id"] not in barrier["participantClaimIds"]):
                    fail("State", "Suspended edit claim has no matching frozen barrier.", 5)
        record_keys: set[tuple[str, str]] = set()
        for item in state["records"]:
            self._record(item, "record", ("roomId", "owner", "key", "canonicalKey", "value", "created"))
            key = (item["roomId"], item["canonicalKey"])
            if (item["roomId"] not in rooms or item["owner"] not in sessions or not isinstance(item["value"], dict)
                    or not isinstance(item["key"], str) or key in record_keys):
                fail("State", "Invalid/duplicate immutable room record.", 5)
            record_keys.add(key)
        for item in state["messages"]:
            self._record(item, "message", ("roomId", "owner", "text", "data", "created"))
            if (item["roomId"] not in rooms or item["owner"] not in sessions
                    or not isinstance(item["text"], str) or not isinstance(item["data"], dict)):
                fail("State", "Invalid room message.", 5)
        adapters: dict[str, dict[str, Any]] = {}
        for item in state["adapters"]:
            self._record(item, "adapter", ("name", "path", "sha256", "owner"))
            name = item["name"]
            if (not isinstance(name, str) or name.casefold() in adapters or not isinstance(item["path"], str)
                    or not re.fullmatch(r"[A-F0-9]{64}", item["sha256"]) or item["owner"] not in sessions):
                fail("State", "Invalid stored adapter registration.", 5)
            assert_id(name)
            adapters[name.casefold()] = item
        targets: dict[str, dict[str, Any]] = {}
        for item in state["targets"]:
            self._record(item, "target", (
                "id", "fingerprint", "adapter", "resources", "config", "state", "generation", "owner", "lastInspection",
            ))
            ident = item["id"]
            if (not isinstance(ident, str) or ident.casefold() in targets
                    or item["adapter"].casefold() not in adapters or not isinstance(item["config"], dict)
                    or not isinstance(item["state"], dict) or item["owner"] not in sessions
                    or not self._integer(item["generation"])):
                fail("State", "Invalid stored target descriptor.", 5)
            assert_target_id(ident)
            text(item, "fingerprint")
            self._validate_resources(item["resources"])
            targets[ident.casefold()] = item
        previous_sequence = 0
        request_owners: set[str] = set()
        for item in state["requests"]:
            self._record(item, "request", (
                "sequence", "owner", "roomId", "targetId", "fingerprint", "descriptorGeneration", "purpose", "created",
            ))
            if (item["owner"] not in sessions or item["owner"] in request_owners
                    or item["roomId"] not in rooms or item["targetId"].casefold() not in targets
                    or not self._integer(item["sequence"]) or item["sequence"] <= previous_sequence
                    or item["sequence"] > state["sequence"]):
                fail("State", "Invalid FIFO request ownership/order.", 5)
            request_owners.add(item["owner"])
            previous_sequence = item["sequence"]
        runtime = state["runtime"]
        for field in ("owned", "participants", "turn", "targetId", "fingerprint", "descriptorGeneration", "generation", "owner"):
            if field not in runtime:
                fail("State", f"Missing runtime.{field}.", 5)
        if (not isinstance(runtime["owned"], bool) or (runtime["owned"] and not runtime["targetId"])
                or not isinstance(runtime["participants"], list)
                or any(member not in sessions for member in runtime["participants"])):
            fail("State", "Invalid runtime participants.", 5)
        turn = runtime["turn"]
        if turn is not None:
            self._record(turn, "turn", (
                "id", "generation", "owner", "roomId", "barrierGeneration", "candidate", "targetId",
                "fingerprint", "descriptorGeneration", "resources", "claimId", "activated",
            ))
            if (turn["owner"] not in sessions or turn["roomId"] not in rooms
                    or turn["targetId"].casefold() not in targets or not isinstance(turn["activated"], bool)
                    or not self._integer(turn["generation"])
                    or not any(c.get("id") == turn["claimId"] and c.get("kind") == "turn" and c.get("owner") == turn["owner"]
                               for c in state["claims"])):
                fail("State", "Invalid prepared runtime turn.", 5)
            self._validate_resources(turn["resources"])
        if (not self._integer(runtime["generation"])
                or (runtime["targetId"] and runtime["targetId"].casefold() not in targets)
                or (runtime["status"] == "running" and not runtime["targetId"])):
            fail("State", "Invalid runtime descriptor/generation.", 5)
        for use in runtime["uses"]:
            self._record(use, "use", (
                "id", "owner", "roomId", "targetId", "fingerprint", "descriptorGeneration", "runtimeGeneration", "purpose", "created",
            ))
            if (use["owner"] not in sessions or use["roomId"] not in rooms
                    or use["targetId"] != runtime["targetId"] or use["fingerprint"] != runtime["fingerprint"]
                    or use["runtimeGeneration"] != runtime["generation"]
                    or use["descriptorGeneration"] != runtime["descriptorGeneration"]):
                fail("State", "Invalid protected runtime use.", 5)
        operation = state["operation"]
        if operation is not None:
            self._record(operation, "operation", (
                "id", "generation", "owner", "kind", "status", "phase", "started", "pid", "processStarted",
                "previousTarget", "requestedTarget", "requestId", "claimIds", "results", "error", "barrier",
                "requiresResourceReconciliation", "ownedTargets", "launchAttempts",
            ))
            if (operation["owner"] not in sessions or operation["generation"] != state["operationGeneration"]
                    or operation["status"] not in ("running", "faulted")
                    or operation["kind"] not in ("activate", "prepare", "supersede-target", "park", "run", "recover")
                    or not isinstance(operation["claimIds"], list) or not isinstance(operation["results"], list)
                    or not isinstance(operation["requiresResourceReconciliation"], bool)
                    or not isinstance(operation["ownedTargets"], list) or not isinstance(operation["launchAttempts"], list)):
                fail("State", "Invalid durable operation ownership.", 5)
            pending = operation.get("pendingDescriptor")
            if pending is not None:
                self._record(pending, "pendingDescriptor", (
                    "id", "fingerprint", "adapter", "resources", "config", "state", "generation", "owner", "lastInspection",
                ))
                if (pending["adapter"].casefold() not in adapters or not isinstance(pending["config"], dict)
                        or not isinstance(pending["state"], dict) or pending["owner"] not in sessions):
                    fail("State", "Invalid pending descriptor inventory.", 5)
                assert_target_id(pending["id"])
                self._validate_resources(pending["resources"])
            if any(ident.casefold() not in targets for ident in operation["ownedTargets"]):
                fail("State", "Operation ownership refers to an unregistered target.", 5)
            for attempt in operation["launchAttempts"]:
                self._record(attempt, "launchAttempt", ("targetId", "at", "returned", "status"))
                if attempt["targetId"].casefold() not in targets or not isinstance(attempt["returned"], bool):
                    fail("State", "Invalid durable launch attempt.", 5)
            if any(not any(c.get("id") == claim_id and c.get("kind") == "operation" for c in state["claims"])
                   for claim_id in operation["claimIds"]):
                fail("State", "Operation reservation is missing.", 5)

    @staticmethod
    def _integer(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool)

    @staticmethod
    def _record(value: Any, name: str, fields: tuple[str, ...]) -> None:
        if not isinstance(value, dict) or any(field not in value for field in fields):
            fail("State", f"Malformed {name} record.", 5)

    @staticmethod
    def _validate_resources(resources: Any) -> None:
        if not isinstance(resources, list) or not resources:
            fail("State", "Malformed stored resource array.", 5)
        for item in resources:
            if (not isinstance(item, dict) or any(key not in item for key in ("kind", "identity", "mode"))
                    or item["kind"] not in ("key", "path") or item["mode"] not in ("shared", "exclusive")
                    or not isinstance(item["identity"], str) or not item["identity"].strip()):
                fail("State", "Malformed stored resource identity/mode.", 5)
            if item["kind"] == "path":
                if _is_windows() and not re.match(r"^[A-Z]:\\", item["identity"]):
                    fail("State", "Stored resource path is not canonical.", 5)
                if not pathlib.Path(item["identity"]).is_absolute():
                    fail("State", "Stored resource path is not absolute.", 5)

    def _save(self, state: dict[str, Any]) -> None:
        state["revision"] += 1
        data_json = compact_json(state)
        envelope = {"schema": 2, "sha256": digest(data_json), "data": state}
        encoded = compact_json(envelope).encode("utf-8")
        pending = self.root / f"snapshot-{new_id()}.pending"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(pending, flags, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        deadline = time.monotonic() + (2 if _is_windows() else 0)
        while True:
            try:
                os.replace(pending, self.root / "state.json")
                if not _is_windows():
                    directory_fd = os.open(self.root, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                return
            except OSError as error:
                if not _is_windows() or getattr(error, "winerror", None) not in (5, 32, 33) or time.monotonic() >= deadline:
                    fail("State", f"Cannot commit snapshot; ownership remains at the last committed state. Preserve {pending}. {error}", 5)
                time.sleep(0.025)

    @contextlib.contextmanager
    def transaction(self, *, read_only: bool = False) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
        lock, created = _lock_file(self.root / "state.lock")
        try:
            state = self._read(created)
            _lock_owner(lock, self.action, self.session_id)
            box: dict[str, Any] = {}
            yield state, box
            if not read_only or created:
                self._save(state)
        finally:
            lock.close()


def get_session(state: dict[str, Any], ident: str) -> dict[str, Any]:
    assert_id(ident)
    found = [item for item in state["sessions"] if item["id"] == ident]
    if len(found) != 1 or found[0]["left"]:
        fail("Owner", "Unknown or departed session. Reuse your own durable session ID.", 4)
    return found[0]


def get_room(state: dict[str, Any], ident: str, owner: str = "") -> dict[str, Any]:
    assert_id(ident)
    found = [item for item in state["rooms"] if item["id"] == ident]
    if len(found) != 1:
        fail("Invalid", "Unknown room.")
    if owner and owner not in found[0]["members"]:
        fail("Owner", "Session is not a member of this room.", 4)
    return found[0]


def _iso_key(value: str) -> str:
    if value != value.strip() or re.search(r"[\x00-\x1f]", value):
        fail("Invalid", "Keys cannot contain control characters or surrounding whitespace.")
    return unicodedata.normalize("NFC", value).upper()


def convert_resources(resources: Any, *, exclusive: bool = False, allow_empty: bool = False) -> list[dict[str, str]]:
    if not isinstance(resources, list) or (not resources and not allow_empty):
        fail("Invalid", "resources must be a nonempty JSON array.")
    result: list[dict[str, str]] = []
    for item in resources:
        item = require_map(item, "resource")
        kind = text(item, "kind").lower()
        mode = text(item, "mode").lower()
        ident = text(item, "identity")
        if kind not in ("key", "path") or mode not in ("shared", "exclusive"):
            fail("Invalid", "Resource kind must be key/path and mode shared/exclusive.")
        if kind == "path":
            ident = str(_safe_resource_path(ident))
            if _is_windows():
                ident = ident.upper()
        else:
            ident = _iso_key(ident)
        result.append({"kind": kind, "identity": ident, "mode": "exclusive" if exclusive else mode})
    return result


def test_overlap(first: dict[str, Any], second: dict[str, Any]) -> bool:
    left = first["identity"].casefold()
    right = second["identity"].casefold()
    if left == right:
        return True
    if first["kind"] != second["kind"] or first["kind"] != "path":
        return False
    sep = "\\" if _is_windows() else os.sep
    left_prefix = left.rstrip("\\/") + sep
    right_prefix = right.rstrip("\\/") + sep
    return left.startswith(right_prefix) or right.startswith(left_prefix)


def assert_no_state_overlap(state: dict[str, Any], resources: list[dict[str, Any]]) -> None:
    control = {"kind": "path", "identity": state["root"]}
    if any(test_overlap(item, control) for item in resources):
        fail("Path", "Declared resources cannot contain or overlap the coordinator state root.")


def assert_claims_available(state: dict[str, Any], resources: list[dict[str, Any]], except_ids: list[str] | None = None,
                            *, waitable: bool = False) -> None:
    assert_no_state_overlap(state, resources)
    excluded = set(except_ids or [])
    for claim in state["claims"]:
        if claim["id"] in excluded:
            continue
        for held in claim["resources"]:
            if held["kind"] == "path":
                _safe_resource_path(held["identity"])
            for wanted in resources:
                if (held["mode"] == "exclusive" or wanted["mode"] == "exclusive") and test_overlap(held, wanted):
                    message = f"Resource {wanted['identity']} conflicts with claim {claim['id']}, owner {claim.get('owner')}, room {claim.get('roomId')}."
                    if waitable:
                        fail("Busy", message, 6)
                    fail("Conflict", message, 3)


def add_claim(state: dict[str, Any], owner: str, room_id: str, kind: str,
              resources: list[dict[str, Any]]) -> dict[str, Any]:
    claim = {"id": new_id(), "owner": owner, "roomId": room_id, "kind": kind,
             "resources": resources, "created": now(), "suspendedBy": None}
    if kind == "runtime":
        claim["owner"] = None
        claim["targetId"] = state["runtime"]["targetId"]
    state["claims"].append(claim)
    return claim


def add_event(state: dict[str, Any], action: str, owner: str, message: str = "") -> None:
    state["events"].append({
        "id": new_id(), "at": now(), "action": action, "owner": owner, "message": message,
        "operationId": state["operation"]["id"] if state.get("operation") else None,
        "operationGeneration": state["operationGeneration"],
    })


def add_room_event(state: dict[str, Any], action: str, owner: str, message: str = "") -> None:
    add_event(state, action, owner, message)


def invalidate_readiness(state: dict[str, Any], resources: list[dict[str, Any]]) -> None:
    for room in state["rooms"]:
        barrier = room.get("barrier")
        if barrier is None or barrier["frozen"]:
            continue
        if any(wanted["mode"] == "exclusive" and test_overlap(wanted, scope)
               for wanted in resources for scope in barrier["resources"]):
            barrier["ready"] = []
            barrier["dirty"] = True


def get_claim_ids_for_cohort(state: dict[str, Any], room: dict[str, Any]) -> list[str]:
    barrier = room["barrier"]
    ids: list[str] = []
    for claim in state["claims"]:
        if claim["kind"] != "manual" or claim["roomId"] != room["id"] or claim["owner"] not in barrier["cohort"] or claim["suspendedBy"] is not None:
            continue
        if all(any(resource["kind"] == scope["kind"] and (
                resource["identity"].casefold() == scope["identity"].casefold()
                or (resource["kind"] == "path" and resource["identity"].casefold().startswith(scope["identity"].rstrip("\\/").casefold() + os.sep.casefold()))
            ) for scope in barrier["resources"]) for resource in claim["resources"]):
            ids.append(claim["id"])
    return ids


def add_simple_action(state: dict[str, Any], action: str, request: dict[str, Any], owner: str,
                      current_boot: str) -> Any:
    boot_mismatch = not _same_boot(state["boot"], current_boot)
    if action == "inspect":
        return {"state": state, "bootMismatch": boot_mismatch,
                "recoveryRequired": state.get("operation") is not None or state["runtime"]["status"] == "faulted" or boot_mismatch}

    recovery_join = action == "join" and request.get("recoverBoot") is True
    if action == "join" and "recoverBoot" in request and not isinstance(request["recoverBoot"], bool):
        fail("Invalid", "recoverBoot must be a boolean.")
    if recovery_join:
        if not boot_mismatch or owner or "roomId" in request or "roomKey" in request:
            fail("Invalid", "recoverBoot requires a boot mismatch and a new session and room.")
        runtime = state["runtime"]
        if (any(not session["left"] for session in state["sessions"]) or state["claims"] or state["requests"]
                or state["operation"] is not None or runtime["status"] != "stopped" or runtime["owned"]
                or runtime["targetId"] is not None or runtime["uses"] or runtime["participants"]
                or runtime["turn"] is not None
                or any((room.get("barrier") or {}).get("frozen") for room in state["rooms"])):
            fail("Boot", "Recovery-only join requires no live owners or reservations. Resume the recorded owner to reconcile.", 5)
    if action not in ("release-use", "release", "cancel", "message") and boot_mismatch and not recovery_join:
        fail("Boot", "Boot identity changed. Explicit reconciliation is required before work resumes.", 5)
    if action != "join":
        get_session(state, owner)

    if action == "join":
        if "roomId" in request and "roomKey" in request:
            fail("Invalid", "Select either roomId or roomKey, never both.")
        canonical_key = _iso_key(text(request, "roomKey")) if "roomKey" in request else None
        if owner:
            session = get_session(state, owner)
        else:
            session = {"id": new_id(), "client": text(request, "client"), "purpose": text(request, "purpose"),
                       "joined": now(), "left": False}
            if "clientSession" in request:
                # The harness's own session ID, so guards outside the coordinator can tell
                # which client session holds access.
                session["clientSession"] = text(request, "clientSession")
            state["sessions"].append(session)
            owner = session["id"]
        room = None
        if "roomId" in request:
            room = get_room(state, text(request, "roomId"), "")
        elif canonical_key is not None:
            matches = [item for item in state["rooms"] if item.get("roomKey") == canonical_key]
            if len(matches) == 1:
                room = matches[0]
        if room is None:
            room = {"id": new_id(), "name": text(request, "name"), "owner": owner, "members": [],
                    "generation": 0, "barrier": None}
            if canonical_key is not None:
                room["roomKey"] = canonical_key
            state["rooms"].append(room)
        if owner not in room["members"]:
            room["members"].append(owner)
        result = {"sessionId": owner, "roomId": room["id"], "roomGeneration": room["generation"],
                  "roomKey": room.get("roomKey"),
                  "nextCohortOnly": room.get("barrier") is not None and owner not in room["barrier"]["cohort"]}
        if recovery_join:
            result["recoveryOnly"] = True
        return result

    if action == "record":
        room = get_room(state, text(request, "roomId"), owner)
        key = text(request, "key")
        canonical = _iso_key(key)
        if any(item["roomId"] == room["id"] and item["canonicalKey"] == canonical for item in state["records"]):
            fail("Conflict", "Room record key already exists; records are immutable, including for their creator.", 3)
        value = require_map(required(request, "value"), "value")
        record = {"id": new_id(), "roomId": room["id"], "owner": owner, "key": key,
                  "canonicalKey": canonical, "value": value, "created": now()}
        state["records"].append(record)
        return record

    if action == "message":
        room = get_room(state, text(request, "roomId"), owner)
        data = require_map(request.get("data", {}), "data")
        message = {"id": new_id(), "roomId": room["id"], "owner": owner, "text": text(request, "text"),
                   "data": data, "created": now()}
        state["messages"].append(message)
        return message

    if action in ("claim", "wait-claim"):
        room = get_room(state, text(request, "roomId"), owner)
        if any(item["owner"] == owner for item in state["requests"]):
            fail("Conflict", "Do not acquire claims while your runtime request is queued.", 3)
        resources = convert_resources(required(request, "resources"))
        assert_claims_available(state, resources, waitable=action == "wait-claim")
        invalidate_readiness(state, resources)
        return add_claim(state, owner, room["id"], "manual", resources)

    if action == "release":
        ident = text(request, "claimId")
        matches = [item for item in state["claims"] if item["id"] == ident]
        if len(matches) != 1:
            fail("Invalid", "Unknown claim.")
        claim = matches[0]
        if claim["owner"] != owner or claim["kind"] != "manual":
            fail("Owner", "Only the owning session can release a manual claim. Runtime/operation/barrier claims have dedicated transitions.", 4)
        if claim["suspendedBy"] is not None:
            fail("Busy", "This edit claim is suspended by a frozen barrier; thaw before release or further editing.", 6)
        state["claims"] = [item for item in state["claims"] if item["id"] != ident]
        return {"released": ident}

    if action == "cohort":
        room = get_room(state, text(request, "roomId"), owner)
        assert_idle_operation(state)
        if room.get("barrier") is not None and room["owner"] != owner:
            fail("Owner", "An existing candidate remains owned by its captain until thaw; leadership is acquired only at a candidate boundary.", 4)
        assert_generation(room["generation"], required(request, "expectedGeneration"))
        if state["runtime"].get("turn") is not None and state["runtime"]["turn"]["roomId"] == room["id"]:
            fail("Busy", "Release the prepared turn before redefining its candidate.", 6)
        if room.get("barrier") is not None and room["barrier"]["frozen"]:
            fail("Conflict", "Thaw before changing the cohort/candidate.", 3)
        cohort = required(request, "cohort")
        if not isinstance(cohort, list) or not cohort or len(set(cohort)) != len(cohort):
            fail("Invalid", "cohort must be an explicit, nonempty, unique session ID array.")
        if any(not isinstance(member, str) or member not in room["members"] for member in cohort):
            fail("Invalid", "Every cohort participant must already be a room member.")
        resources = convert_resources(required(request, "resources"), exclusive=True)
        assert_no_state_overlap(state, resources)
        room["owner"] = owner
        room["generation"] += 1
        room["barrier"] = {"generation": room["generation"], "candidate": text(request, "candidate"),
                           "cohort": cohort, "resources": resources, "ready": [], "dirty": False,
                           "frozen": False, "owner": owner, "claimId": None, "participantClaimIds": []}
        return room["barrier"]

    if action in ("ready", "unready", "freeze", "thaw"):
        room = get_room(state, text(request, "roomId"), owner)
        barrier = room.get("barrier")
        if barrier is None:
            fail("Invalid", "Define an explicit cohort first.")
        assert_generation(barrier["generation"], required(request, "generation"))
        if text(request, "candidate") != barrier["candidate"]:
            fail("Generation", "Candidate mismatch.", 3)
        if action in ("ready", "unready"):
            if barrier["frozen"]:
                fail("Conflict", "Frozen participants cannot change readiness.", 3)
            if owner not in barrier["cohort"]:
                fail("Owner", "Late joiners must wait for the next cohort generation.", 4)
            if action == "ready":
                if barrier["dirty"]:
                    fail("Generation", "An exclusive claim invalidated the candidate. Define a new cohort generation.", 3)
                except_ids = get_claim_ids_for_cohort(state, room)
                turn = state["runtime"].get("turn")
                if turn is not None and turn["roomId"] == room["id"]:
                    except_ids.append(turn["claimId"])
                assert_claims_available(state, barrier["resources"], except_ids)
                if owner not in barrier["ready"]:
                    barrier["ready"].append(owner)
            else:
                barrier["ready"] = [member for member in barrier["ready"] if member != owner]
        else:
            if barrier["owner"] != owner:
                fail("Owner", "Only the barrier owner may freeze/thaw.", 4)
            if action == "freeze":
                if barrier["frozen"] or barrier["dirty"] or any(member not in barrier["ready"] for member in barrier["cohort"]):
                    fail("Barrier", "The exact cohort/candidate must be ready and unfrozen.", 3)
                if any(item["owner"] == owner for item in state["requests"]):
                    fail("Conflict", "Complete/cancel runtime requests before freezing claims.", 3)
                participant_ids = get_claim_ids_for_cohort(state, room)
                except_ids = list(participant_ids)
                turn = state["runtime"].get("turn")
                if turn is not None and turn["roomId"] == room["id"]:
                    get_owned_turn(state, request, owner)
                    get_turn_barrier(state, turn)
                    except_ids.append(turn["claimId"])
                assert_claims_available(state, barrier["resources"], except_ids)
                claim = add_claim(state, owner, room["id"], "freeze", barrier["resources"])
                barrier["claimId"] = claim["id"]
                barrier["participantClaimIds"] = participant_ids
                for held in state["claims"]:
                    if held["id"] in participant_ids:
                        held["suspendedBy"] = {"roomId": room["id"], "generation": barrier["generation"],
                                               "freezeClaimId": claim["id"]}
                barrier["frozen"] = True
            else:
                if not barrier["frozen"]:
                    fail("Barrier", "The barrier is not frozen.", 3)
                operation = state.get("operation")
                if operation is not None and operation.get("barrier") and operation["barrier"]["roomId"] == room["id"]:
                    fail("Busy", "The frozen operation must finish/recover before thaw.", 6)
                turn = state["runtime"].get("turn")
                if turn is not None and turn["roomId"] == room["id"]:
                    get_owned_turn(state, request, owner)
                    if state["runtime"]["targetId"] or state["runtime"]["status"] != "stopped":
                        fail("Busy", "Park/reconcile the prepared runtime before restoring participant writes.", 6)
                restored = [held["resources"] for held in state["claims"] if held["id"] in barrier["participantClaimIds"]]
                except_ids = [barrier["claimId"], *barrier["participantClaimIds"]]
                if turn is not None and turn["roomId"] == room["id"]:
                    except_ids.append(turn["claimId"])
                assert_claims_available(state, [item for group in restored for item in group], except_ids)
                for held in state["claims"]:
                    if held["id"] in barrier["participantClaimIds"]:
                        held["suspendedBy"] = None
                state["claims"] = [held for held in state["claims"] if held["id"] != barrier["claimId"]]
                room["generation"] += 1
                room["barrier"] = None
        return {"roomId": room["id"], "generation": room["generation"], "barrier": room.get("barrier")}

    if action == "register-adapter":
        assert_idle_operation(state)
        name = text(request, "name")
        assert_id(name)
        if any(item["name"].casefold() == name.casefold() for item in state["adapters"]):
            fail("Adapter", "Adapter name already registered; replacement is never implicit.", 3)
        path = _canonical_path(text(request, "path"), must_exist=True, file=True)
        if path.suffix.casefold() != ".py":
            fail("Adapter", "Register a local Python adapter (.py).")
        sha = text(request, "sha256").upper()
        if not re.fullmatch(r"[A-F0-9]{64}", sha) or hashlib.sha256(path.read_bytes()).hexdigest().upper() != sha:
            fail("Adapter", "Registration SHA256 does not match the adapter.")
        adapter = {"name": name, "path": str(path), "sha256": sha, "owner": owner}
        state["adapters"].append(adapter)
        return adapter

    if action == "register-target":
        assert_idle_operation(state)
        descriptor = new_descriptor(state, required(request, "target"), owner)
        if any(item["id"].casefold() == descriptor["id"].casefold() for item in state["targets"]):
            fail("Descriptor", "Target ID already registered. Use explicit stopped supersession; no implicit replacement.", 3)
        if state["runtime"].get("turn") is not None:
            fail("Busy", "Do not extend inventory during a reserved candidate; use exact descriptor supersession.", 6)
        state["targetGeneration"] = descriptor["generation"]
        state["targets"].append(descriptor)
        return descriptor

    if action == "request":
        assert_idle_operation(state)
        room = get_room(state, text(request, "roomId"), owner)
        assert_no_reservations(state, owner)
        if any(item["owner"] == owner for item in state["requests"]):
            fail("Queue", "One outstanding runtime request per session is allowed.", 3)
        target = get_target(state, text(request, "targetId"))
        assert_target_version(target, request)
        state["sequence"] += 1
        queued = {"id": new_id(), "sequence": state["sequence"], "owner": owner, "roomId": room["id"],
                  "targetId": target["id"], "fingerprint": target["fingerprint"],
                  "descriptorGeneration": target["generation"], "purpose": text(request, "purpose"), "created": now()}
        if "barrierGeneration" in request:
            barrier = room.get("barrier")
            if barrier is None or barrier["owner"] != owner or barrier["frozen"] or barrier["dirty"]:
                fail("Barrier", "Candidate requests require your own clean, unfrozen cohort.", 3)
            assert_generation(barrier["generation"], request["barrierGeneration"])
            if text(request, "candidate") != barrier["candidate"]:
                fail("Generation", "Candidate mismatch.", 3)
            queued["barrierGeneration"] = barrier["generation"]
            queued["candidate"] = barrier["candidate"]
        state["requests"].append(queued)
        return queued

    if action == "cancel":
        ident = text(request, "requestId")
        matches = [item for item in state["requests"] if item["id"] == ident]
        if len(matches) != 1:
            fail("Invalid", "Unknown pending request.")
        if matches[0]["owner"] != owner:
            fail("Owner", "Only the requester may cancel.", 4)
        if state.get("operation") is not None and state["operation"].get("requestId") == ident:
            fail("Busy", "An owned transition must finish/recover before cancellation.", 6)
        state["requests"] = [item for item in state["requests"] if item["id"] != ident]
        return {"cancelled": ident}

    if action == "release-use":
        ident = text(request, "useId")
        matches = [item for item in state["runtime"]["uses"] if item["id"] == ident]
        if len(matches) != 1:
            fail("Invalid", "Unknown runtime use.")
        if matches[0]["owner"] != owner:
            fail("Owner", "Only the owning session may release a runtime use.", 4)
        state["runtime"]["uses"] = [item for item in state["runtime"]["uses"] if item["id"] != ident]
        return {"released": ident, "runtimeGeneration": state["runtime"]["generation"]}

    if action == "release-turn":
        assert_idle_operation(state)
        turn = get_owned_turn(state, request, owner)
        room = get_room(state, turn["roomId"], owner)
        if (state["runtime"]["targetId"] or state["runtime"]["uses"]
                or (room.get("barrier") is not None and room["barrier"]["frozen"])):
            fail("Busy", "Park and thaw before releasing the prepared turn; an unfrozen stopped turn may be cancelled directly.", 6)
        state["claims"] = [item for item in state["claims"] if item["id"] != turn["claimId"]]
        state["runtime"]["turn"] = None
        return {"released": turn["id"]}

    if action == "leave":
        if (any(item["owner"] == owner and item["kind"] != "runtime" for item in state["claims"])
                or any(item["owner"] == owner for item in state["requests"])
                or any(item["owner"] == owner for item in state["runtime"]["uses"])
                or (state.get("operation") is not None and state["operation"]["owner"] == owner)):
            fail("Conflict", "Release owned claims/uses, cancel requests and finish/recover operations before leaving.", 3)
        for room in state["rooms"]:
            barrier = room.get("barrier")
            if barrier is not None and (owner in barrier["cohort"] or owner == barrier["owner"]):
                fail("Barrier", "Cohort participants must finish and thaw before leaving.", 3)
        if state["runtime"]["targetId"] and owner in state["runtime"]["participants"]:
            if not any(not session["left"] and session["id"] != owner and session["id"] in state["runtime"]["participants"] for session in state["sessions"]):
                fail("ParkRequired", "The last runtime participant must park before departing.", 3)
        session = get_session(state, owner)
        session["left"] = True
        for room in state["rooms"]:
            room["members"] = [member for member in room["members"] if member != owner]
        return {"sessionId": owner, "left": True}

    fail("Invalid", f"Unsupported action: {action}")


def assert_idle_operation(state: dict[str, Any]) -> None:
    if state.get("operation") is not None or state["runtime"]["status"] == "faulted":
        fail("Fault", "An operation/fault still owns the machine. Inspect and explicitly recover it; no timeout releases ownership.", 5)


def get_target(state: dict[str, Any], ident: str) -> dict[str, Any]:
    assert_target_id(ident)
    found = [item for item in state["targets"] if item["id"].casefold() == ident.casefold()]
    if len(found) != 1:
        fail("Descriptor", f"Target is not registered: {ident}")
    return found[0]


def get_adapter(state: dict[str, Any], name: str) -> dict[str, Any]:
    found = [item for item in state["adapters"] if item["name"].casefold() == name.casefold()]
    if len(found) != 1:
        fail("Adapter", f"Adapter is not registered: {name}", 5)
    adapter = found[0]
    path = _canonical_path(adapter["path"], must_exist=True, file=True)
    if path.suffix.casefold() != ".py":
        fail("Adapter", "This release requires Python adapters. Reconcile legacy registrations before upgrading.", 5)
    try:
        actual = hashlib.sha256(path.read_bytes()).hexdigest().upper()
    except OSError as error:
        fail("Adapter", f"Cannot read pinned adapter: {error}", 5)
    if actual != adapter["sha256"]:
        fail("Adapter", f"Pinned adapter changed: {name}. Register a new adapter name/path; never silently replace a pin.", 5)
    return adapter


def new_descriptor(state: dict[str, Any], target: Any, owner: str) -> dict[str, Any]:
    target = require_map(target, "target")
    for field in ("id", "fingerprint", "adapter", "resources", "config", "state"):
        required(target, field)
    ident = text(target, "id")
    assert_target_id(ident)
    config = require_map(target["config"], "target.config")
    initial_state = require_map(target["state"], "target.state")
    if initial_state:
        fail("Descriptor", "Initial state must be empty; use explicit inventory/adoption, not injected identities.")
    adapter_name = text(target, "adapter")
    get_adapter(state, adapter_name)
    descriptor = {"id": ident, "fingerprint": text(target, "fingerprint"), "adapter": adapter_name,
                  "resources": convert_resources(target["resources"]), "config": config, "state": {},
                  "generation": state["targetGeneration"] + 1, "owner": owner, "lastInspection": None}
    assert_no_state_overlap(state, descriptor["resources"])
    return descriptor


def assert_target_version(target: dict[str, Any], request: dict[str, Any]) -> None:
    if text(request, "fingerprint") != target["fingerprint"]:
        fail("Generation", "Target fingerprint does not match the registered descriptor.", 3)
    assert_generation(target["generation"], required(request, "descriptorGeneration"))


def assert_no_reservations(state: dict[str, Any], owner: str) -> None:
    if any(item["owner"] == owner and item["kind"] in ("manual", "freeze", "operation", "turn") for item in state["claims"]):
        fail("Conflict", "Release manual/freeze claims before queueing runtime work; never wait while holding reservations.", 3)
    if any(item["owner"] == owner for item in state["runtime"]["uses"]):
        fail("Conflict", "Release existing runtime uses before queueing another request.", 3)


def get_owned_turn(state: dict[str, Any], request: dict[str, Any], owner: str) -> dict[str, Any]:
    turn = state["runtime"].get("turn")
    if turn is None or turn["owner"] != owner or turn["id"] != text(request, "turnId"):
        fail("Owner", "Only the exact prepared-turn owner/token may act within its reservation.", 4)
    assert_generation(turn["generation"], required(request, "turnGeneration"))
    return turn


def get_turn_barrier(state: dict[str, Any], turn: dict[str, Any], *, frozen: bool = False) -> dict[str, Any]:
    room = get_room(state, turn["roomId"], turn["owner"])
    barrier = room.get("barrier")
    if (barrier is None or barrier["generation"] != turn["barrierGeneration"] or barrier["candidate"] != turn["candidate"]
            or barrier["dirty"] or (frozen and not barrier["frozen"])):
        fail("Barrier", "The exact prepared candidate barrier is required.", 3)
    return barrier


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Cross-platform shared resource coordinator")
    parser.add_argument("--root", default=str(pathlib.Path.home() / ".resource-rooms"))
    parser.add_argument("--action", required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--request-file")
    group.add_argument("--request-json", default="{}")
    args = parser.parse_args(argv)
    try:
        request = json.loads(pathlib.Path(args.request_file).read_text(encoding="utf-8")) if args.request_file else json.loads(args.request_json)
        request = require_map(request, "Request")
        action = args.action
        valid = {
            "inspect", "join", "record", "message", "claim", "wait-claim", "release", "cohort", "ready",
            "unready", "freeze", "thaw", "register-adapter", "register-target", "supersede-target", "rebind-adapter", "request",
            "prepare", "activate", "release-use", "release-turn", "cancel", "park", "run", "leave", "recover",
        }
        if action not in valid:
            fail("Invalid", f"Unknown action: {action}")
        root = _canonical_path(args.root)
        if str(root) == root.anchor:
            fail("Path", "A filesystem root is not a coordination directory.")
        root.mkdir(parents=True, exist_ok=True)
        root = _canonical_path(str(root), must_exist=True)
        owner = text(request, "sessionId") if "sessionId" in request else ""
        if action not in ("join", "inspect") and not owner:
            fail("Invalid", "sessionId is required.")
        host, boot = _host_identity()
        store = RoomStore(root, host, boot, action, owner)
        with store.transaction(read_only=True):
            pass
        if action == "wait-claim":
            data = wait_claim(store, request, owner)
        elif action in ("activate", "prepare", "park"):
            data = activate_or_park(store, request, owner, prepare=action == "prepare", park=action == "park")
        elif action == "supersede-target":
            data = supersede_target(store, request, owner)
        elif action == "rebind-adapter":
            from resource_room_operations import rebind_adapter

            data = rebind_adapter(store, request, owner)
        elif action == "run":
            data = run_room_script(store, request, owner)
        elif action == "recover":
            data = recover_room(store, request, owner)
        elif action == "leave":
            try:
                data = simple_transaction(store, action, request, owner)
            except RoomError as error:
                if error.code != "ParkRequired":
                    raise
                with store.transaction(read_only=True) as (state, _):
                    generation = state["runtime"]["generation"]
                activate_or_park(store, {"runtimeGeneration": generation}, owner, park=True)
                data = simple_transaction(store, action, request, owner)
        else:
            data = simple_transaction(store, action, request, owner)
        print(compact_json({"ok": True, "action": action, "data": data}))
        return 0
    except RoomError as error:
        print(compact_json({"ok": False, "code": error.code, "message": str(error)}))
        return error.exit_code
    except (json.JSONDecodeError, OSError, UnicodeError) as error:
        print(compact_json({"ok": False, "code": "Invalid", "message": str(error)}))
        return 2


def simple_transaction(store: RoomStore, action: str, request: dict[str, Any], owner: str) -> Any:
    with store.transaction(read_only=action == "inspect") as (state, _):
        result = add_simple_action(state, action, request, owner, store.boot)
        if action != "inspect":
            add_room_event(state, action, owner)
        return result


def wait_claim(store: RoomStore, request: dict[str, Any], owner: str) -> Any:
    timeout_ms = request.get("timeoutMs", 300000)
    poll_ms = request.get("pollMs", 1000)
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 0 <= timeout_ms <= 86_400_000:
        fail("Invalid", "timeoutMs must be an integer from 0 to 86400000.")
    if isinstance(poll_ms, bool) or not isinstance(poll_ms, int) or not 10 <= poll_ms <= 5000:
        fail("Invalid", "pollMs must be an integer from 10 to 5000.")
    started = time.monotonic()
    attempts = 0
    while True:
        attempts += 1
        try:
            with store.transaction() as (state, _):
                claim = add_simple_action(state, "wait-claim", request, owner, store.boot)
                add_room_event(state, "claim", owner)
            return {"claim": claim, "attempts": attempts, "waitedMilliseconds": int((time.monotonic() - started) * 1000)}
        except RoomError as error:
            if error.code != "Busy":
                raise
            elapsed = (time.monotonic() - started) * 1000
            if elapsed >= timeout_ms:
                fail("Timeout", f"Resources remained busy for {int(elapsed)}ms.", 3)
            time.sleep(min(poll_ms, timeout_ms - elapsed) / 1000)


def activate_or_park(*args: Any, **kwargs: Any) -> Any:
    from resource_room_operations import activate_or_park as implementation

    return implementation(*args, **kwargs)


def supersede_target(*args: Any, **kwargs: Any) -> Any:
    from resource_room_operations import supersede_target as implementation

    return implementation(*args, **kwargs)


def run_room_script(*args: Any, **kwargs: Any) -> Any:
    from resource_room_operations import run_room_script as implementation

    return implementation(*args, **kwargs)


def recover_room(*args: Any, **kwargs: Any) -> Any:
    from resource_room_operations import recover_room as implementation

    return implementation(*args, **kwargs)


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    sys.modules.setdefault("resource_room", sys.modules[__name__])
    raise SystemExit(main())
