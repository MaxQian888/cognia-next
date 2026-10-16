"""Fixed ADR-0228 receiver. Invoked only by Host protected envd, never shell text."""
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path("/var/lib/cognia-acceptance")
BUNDLE_LIMIT = 512 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024
FILES_LIMIT = 32 * 1024 * 1024
STAGING_LIMIT = 2 * 1024 * 1024 * 1024
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/home/cua", "DISPLAY": ":99", "XDG_RUNTIME_DIR": "/run/user/1000", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1"}


def fail():
    raise ValueError("managed_handoff_guest_refused")


def safe_path(value):
    if not isinstance(value, str) or not value or len(value.encode()) > 1024 or "\\" in value or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        fail()
    parts = value.split("/")
    if PurePosixPath(value).is_absolute() or any(p in ("", ".", "..") for p in parts):
        fail()
    for part in parts:
        p = part.lower()
        if p == ".git" or p == ".env" or p.startswith(".env.") or p in (".ssh", ".aws", ".npmrc", ".pypirc", ".netrc", "credentials", "cookies", "cookies.sqlite", "login data", "local state", "id_rsa", "id_ed25519") or p.endswith((".pem", ".key")):
            fail()
    return parts


def object_id(value):
    return isinstance(value, str) and re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", value) is not None


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def validate(request):
    if set(request) != {"operationId", "manifest", "manifestDigest", "deadlineAtMs", "launch"}:
        fail()
    operation = request["operationId"]
    if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
        fail()
    raw = request["manifest"]
    if not isinstance(raw, str) or len(raw.encode()) > 120 * 1024 or hashlib.sha256(raw.encode()).hexdigest() != request["manifestDigest"]:
        fail()
    manifest = json.loads(raw)
    if set(manifest) != {"version", "commit", "bundleBytes", "bundleSha256", "files"} or type(manifest["version"]) is not int or manifest["version"] != 1 or not object_id(manifest["commit"]):
        fail()
    if type(manifest["bundleBytes"]) is not int or not 0 < manifest["bundleBytes"] <= BUNDLE_LIMIT or not digest(manifest["bundleSha256"]):
        fail()
    files = manifest["files"]
    if not isinstance(files, list) or len(files) > 100:
        fail()
    total, names = 0, set()
    for file in files:
        if set(file) != {"path", "bytes", "sha256"}:
            fail()
        safe_path(file["path"])
        if file["path"] in names or type(file["bytes"]) is not int or not 0 <= file["bytes"] <= FILE_LIMIT or not digest(file["sha256"]):
            fail()
        names.add(file["path"])
        total += file["bytes"]
    if total > FILES_LIMIT or type(request["deadlineAtMs"]) is not int or request["deadlineAtMs"] <= int(time.time() * 1000):
        fail()
    launch = request["launch"]
    if launch is not None and (not isinstance(launch, dict) or set(launch) != {"script"} or not isinstance(launch["script"], str) or not re.fullmatch(r"[a-zA-Z0-9_:][a-zA-Z0-9_:.-]{0,99}", launch["script"])):
        fail()
    return manifest


def read_chunk(stream, size):
    # Real stdin is unbuffered, so readiness covers every byte. Fixture BytesIO
    # has no fd; it is already bounded in memory. A disconnected/stalled Host
    # cannot leave the receiver alive until a long desktop hard deadline.
    try:
        descriptor = stream.fileno()
    except (AttributeError, OSError):
        return stream.read(size)
    if not select.select([descriptor], [], [], 30)[0]:
        fail()
    return stream.read(size)


def receive(stream, path, size, expected_hash):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        hashed, remaining = hashlib.sha256(), size
        with os.fdopen(fd, "wb", closefd=False) as output:
            while remaining:
                chunk = read_chunk(stream, min(65536, remaining))
                if not chunk:
                    fail()
                output.write(chunk)
                hashed.update(chunk)
                remaining -= len(chunk)
            output.flush()
            os.fsync(fd)
        if hashed.hexdigest() != expected_hash:
            fail()
    finally:
        os.close(fd)


def size_bound(root):
    total, count = 0, 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            entry = Path(directory) / name
            try:
                info = entry.lstat()
            except FileNotFoundError:
                # Git atomically renames/removes its lock and temporary pack
                # files while the monitor walks. Final traversal still verifies.
                continue
            count += 1
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
            elif not stat.S_ISDIR(info.st_mode):
                # Source checkout symlinks are forbidden too: they must never
                # redirect a later acceptance upload or preview outside cwd.
                fail()
            if total > STAGING_LIMIT or count > 100000:
                fail()


def git(root, args, deadline):
    command = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always"] + args
    with subprocess.Popen(command, cwd=root, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True) as process:
        try:
            while process.poll() is None:
                if int(time.time() * 1000) >= deadline:
                    fail()
                size_bound(root)
                time.sleep(0.05)
            if process.returncode:
                fail()
            size_bound(root)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def install(request, stream, root=ROOT):
    manifest = validate(request)
    if root.is_symlink():
        fail()
    root.mkdir(mode=0o711, parents=True, exist_ok=True)
    info = root.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        fail()
    operation = request["operationId"]
    final = root / operation
    staging = root / (operation + ".partial")
    # No mutable destination/retry overwrite, including after an uncertain ack.
    if final.exists() or final.is_symlink() or staging.exists() or staging.is_symlink():
        fail()
    staging.mkdir(mode=0o700)
    child = None
    committed = False
    try:
        if shutil.disk_usage(staging).free < STAGING_LIMIT * 2:
            fail()
        reservation = staging / ".reservation"
        with open(reservation, "xb") as reserve:
            os.posix_fallocate(reserve.fileno(), 0, BUNDLE_LIMIT * 2 + FILES_LIMIT)
        bundle = staging / "source.bundle"
        receive(stream, bundle, manifest["bundleBytes"], manifest["bundleSha256"])
        acceptance = staging / "acceptance"
        acceptance.mkdir(mode=0o700)
        for file in manifest["files"]:
            path = acceptance.joinpath(*safe_path(file["path"]))
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            receive(stream, path, file["bytes"], file["sha256"])
        if read_chunk(stream, 1):
            fail()
        workspace = staging / "workspace"
        workspace.mkdir(mode=0o700)
        deadline = request["deadlineAtMs"]
        git(workspace, ["init", "--object-format=" + ("sha256" if len(manifest["commit"]) == 64 else "sha1"), "."], deadline)
        git(workspace, ["bundle", "verify", str(bundle)], deadline)
        git(workspace, ["fetch", "--no-tags", "--", str(bundle), "refs/cognia/acceptance"], deadline)
        git(workspace, ["checkout", "--detach", manifest["commit"]], deadline)
        # A detached HEAD is a bounded text file and cannot be forged by checkout.
        if (workspace / ".git" / "HEAD").read_text().strip() != manifest["commit"]:
            fail()
        bundle.unlink()
        reservation.unlink()
        # Transfer only workspace ownership; control manifest and receipt remain
        # root-owned and source processes cannot replace them.
        account = pwd.getpwnam("cua")
        for tree in (workspace, acceptance):
            for directory, dirs, files in os.walk(tree):
                os.chown(directory, account.pw_uid, account.pw_gid)
                for name in files:
                    os.chown(Path(directory) / name, account.pw_uid, account.pw_gid, follow_symlinks=False)
        (staging / "manifest.json").write_text(request["manifest"], encoding="utf-8")
        os.chmod(staging / "manifest.json", 0o600)
        os.chmod(staging, 0o711)
        # rename without replacing an existing operation; root is trusted and
        # this single-Host operation is fenced by the service before dispatch.
        if final.exists() or final.is_symlink():
            fail()
        staging.rename(final)
        committed = True
        if request["launch"] is not None:
            remaining = max(1, math.ceil((deadline - time.time() * 1000) / 1000))
            if remaining <= 1:
                fail()
            child = subprocess.Popen([
                "/usr/bin/timeout", "--signal=TERM", "--kill-after=3", str(remaining),
                "/usr/sbin/gosu", "cua", "/usr/bin/npm", "--ignore-scripts", "run", request["launch"]["script"],
            ], cwd=final / "workspace", env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            time.sleep(0.1)
            if child.poll() is not None and child.returncode != 0:
                fail()
        return {"operationId": operation, "commit": manifest["commit"], "manifestDigest": request["manifestDigest"], "workspace": str(final / "workspace"), "launched": request["launch"] is not None}
    except BaseException:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        if committed:
            shutil.rmtree(final)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    if sys.platform != "linux" or os.getuid() != 0:
        fail()
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        fail()
    os.umask(0o077)
    os.environ.clear()
    signal.signal(signal.SIGALRM, lambda *_: fail())
    # An abandoned caller cannot leave a receiver waiting forever for header.
    signal.alarm(30)
    stream = sys.stdin.buffer.raw
    header = stream.readline(128 * 1024 + 1)
    if len(header) > 128 * 1024 or not header.endswith(b"\n"):
        fail()
    request = json.loads(header)
    validate(request)
    remaining = min(3600, math.ceil((request["deadlineAtMs"] - time.time() * 1000) / 1000))
    if remaining <= 0:
        fail()
    signal.alarm(remaining)
    result = install(request, stream)
    print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Never echo source code, paths, Git errors or credentials to transport.
        print("managed_handoff_guest_failed", file=sys.stderr)
        sys.exit(1)
