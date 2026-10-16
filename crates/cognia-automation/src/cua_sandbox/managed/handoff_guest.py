"""Fixed unprivileged importer. Root promotion independently verifies every byte.

Only the managed native supervisor admits this program after observing its actual
confinement. This program never promotes, changes ownership, launches project
code, or emits an authoritative receipt.
"""
import errno
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid

BUNDLE_LIMIT = 512 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024
FILES_LIMIT = 32 * 1024 * 1024
STAGING_LIMIT = 2 * 1024 * 1024 * 1024
METADATA_LIMIT = 32 * 1024 * 1024
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/home/importer", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1", "LC_ALL": "C"}


def fail():
    raise ValueError("managed_handoff_guest_refused")


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail()
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


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
    manifest = strict_json(raw)
    if set(manifest) != {"version", "commit", "bundleBytes", "bundleSha256", "sourceTreeSha256", "sourceFileCount", "sourceBytes", "files"} or type(manifest["version"]) is not int or manifest["version"] != 2 or not object_id(manifest["commit"]):
        fail()
    if type(manifest["bundleBytes"]) is not int or not 0 < manifest["bundleBytes"] <= BUNDLE_LIMIT or not digest(manifest["bundleSha256"]):
        fail()
    if not digest(manifest["sourceTreeSha256"]) or type(manifest["sourceFileCount"]) is not int or not 0 <= manifest["sourceFileCount"] <= 100000 or type(manifest["sourceBytes"]) is not int or not 0 <= manifest["sourceBytes"] <= STAGING_LIMIT:
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



def check_deadline(deadline):
    if int(time.time() * 1000) >= deadline:
        fail()


def size_bound(root, git_running=False):
    total, count = 0, 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            try:
                info = (Path(directory) / name).lstat()
            except FileNotFoundError:
                continue  # Git may atomically rename its own temporary files.
            count += 1
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
                # Git publishes loose objects using link/unlink. The size
                # monitor may observe that transient state; final inspection
                # and native promotion still reject all surviving hard links.
                if not git_running and info.st_nlink != 1:
                    fail()
            elif not stat.S_ISDIR(info.st_mode):
                fail()
            if total > STAGING_LIMIT or count > 300000:
                fail()


def git_command(args):
    return ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always"] + args


def git(root, args, deadline, limit=4096):
    # A bounded file avoids pipe deadlock and unbounded communicate() allocation.
    with tempfile.TemporaryFile() as output:
        with subprocess.Popen(git_command(args), cwd=root, env=ENV, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL, start_new_session=True) as process:
            try:
                while process.poll() is None:
                    check_deadline(deadline)
                    if os.fstat(output.fileno()).st_size > limit:
                        fail()
                    size_bound(root, git_running=True)
                    time.sleep(0.02)
                if process.returncode or os.fstat(output.fileno()).st_size > limit:
                    fail()
                size_bound(root)
                output.seek(0)
                return output.read(limit + 1)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def exact(stream, size, deadline):
    result = bytearray()
    while len(result) < size:
        check_deadline(deadline)
        remaining = max(0, (deadline - time.time() * 1000) / 1000)
        if not select.select([stream.fileno()], [], [], min(30, remaining))[0]:
            fail()
        chunk = os.read(stream.fileno(), min(65536, size - len(result)))
        if not chunk:
            fail()
        result.extend(chunk)
    return bytes(result)


def source_entries(listing):
    if len(listing) > METADATA_LIMIT or (listing and not listing.endswith(b"\0")):
        fail()
    entries, names, total, metadata = [], set(), 0, 0
    for record in listing[:-1].split(b"\0") if listing else []:
        fields, path = record.split(b"\t", 1)
        fields = fields.split()
        if len(fields) != 4 or fields[0] not in (b"100644", b"100755") or fields[1] != b"blob" or not object_id(fields[2].decode("ascii")) or not fields[3].isdigit():
            fail()
        if not path or len(path) > 4096 or any(p in (b"", b".", b"..") or p.lower() == b".git" for p in path.split(b"/")) or path in names:
            fail()
        names.add(path)
        size = int(fields[3])
        total += size
        metadata += len(path) * 2 + 45
        if len(names) > 100000 or total > STAGING_LIMIT or metadata > METADATA_LIMIT:
            fail()
        entries.append((path, fields[0] == b"100755", size, fields[2]))
    for path in names:
        if any(path[:index] in names for index, byte in enumerate(path) if byte == 47):
            fail()
    return sorted(entries)


def materialize(root, commit, deadline):
    entries = source_entries(git(root, ["ls-tree", "-rz", "--full-tree", "-l", commit], deadline, METADATA_LIMIT))
    proof = hashlib.sha256(b"cognia-source-tree-v1\0")
    total = sum(entry[2] for entry in entries)
    proof.update(len(entries).to_bytes(8, "big"))
    proof.update(total.to_bytes(8, "big"))
    with subprocess.Popen(git_command(["cat-file", "--batch"]), cwd=root, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, start_new_session=True) as process:
        try:
            for path, executable, size, oid in entries:
                process.stdin.write(oid + b"\n")
                header = bytearray()
                while not header.endswith(b"\n"):
                    if len(header) >= 128:
                        fail()
                    header.extend(exact(process.stdout, 1, deadline))
                if header != oid + b" blob " + str(size).encode() + b"\n":
                    fail()
                target = os.path.join(os.fsencode(root), path)
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if executable else 0o600)
                content, remaining = hashlib.sha256(), size
                with os.fdopen(fd, "wb") as output:
                    while remaining:
                        chunk = exact(process.stdout, min(65536, remaining), deadline)
                        output.write(chunk)
                        content.update(chunk)
                        remaining -= len(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if exact(process.stdout, 1, deadline) != b"\n":
                    fail()
                proof.update(len(path).to_bytes(4, "big") + path + bytes([executable]) + size.to_bytes(8, "big") + content.digest())
            process.stdin.close()
            try:
                code = process.wait(timeout=max(0.001, (deadline - time.time() * 1000) / 1000))
            except subprocess.TimeoutExpired:
                fail()
            if code or process.stdout.read(1):
                fail()
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    size_bound(root)
    return proof.hexdigest(), len(entries), total


def checked_file(path, size, expected, destination=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size:
            fail()
        digest_value = hashlib.sha256()
        output = None
        try:
            if destination is not None:
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                output = os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb")
            remaining = size
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    fail()
                remaining -= len(chunk)
                digest_value.update(chunk)
                if output:
                    output.write(chunk)
            if source.read(1) or digest_value.hexdigest() != expected:
                fail()
            if output:
                output.flush()
                os.fsync(output.fileno())
        finally:
            if output:
                output.close()


def import_source(request, input_root=Path("/input"), output_root=Path("/output")):
    manifest = validate(request)
    if any(output_root.iterdir()):
        fail()
    bundle = input_root / "source.bundle"
    checked_file(bundle, manifest["bundleBytes"], manifest["bundleSha256"])
    workspace, acceptance = output_root / "workspace", output_root / "acceptance"
    workspace.mkdir(mode=0o700)
    acceptance.mkdir(mode=0o700)
    deadline = request["deadlineAtMs"]
    git(workspace, ["init", "--object-format=" + ("sha256" if len(manifest["commit"]) == 64 else "sha1"), "."], deadline)
    git(workspace, ["bundle", "verify", str(bundle)], deadline)
    git(workspace, ["fetch", "--no-tags", "--", str(bundle), "refs/cognia/acceptance"], deadline)
    actual = materialize(workspace, manifest["commit"], deadline)
    if actual != (manifest["sourceTreeSha256"], manifest["sourceFileCount"], manifest["sourceBytes"]):
        fail()
    # Useful Git metadata, never the authority for source identity or promotion.
    git(workspace, ["update-ref", "--no-deref", "HEAD", manifest["commit"]], deadline)
    git(workspace, ["read-tree", manifest["commit"]], deadline)
    for index, file in enumerate(manifest["files"]):
        checked_file(input_root / ("file-" + str(index)), file["bytes"], file["sha256"], acceptance.joinpath(*safe_path(file["path"])))
    size_bound(output_root)
    check_deadline(deadline)


def verify_offline_network():
    # Defense in depth from the actual admitted interpreter. The native parent
    # independently verifies namespace identity, interfaces and routes; this
    # result is not a replacement for its boundary observation.
    targets = [(socket.AF_INET, "169.254.169.254", 0),
               (socket.AF_INET6, "::ffff:169.254.169.254", 0),
               (socket.AF_INET, "10.0.0.1", 0),
               (socket.AF_INET, "172.16.0.1", 0),
               (socket.AF_INET, "192.168.0.1", 0),
               (socket.AF_INET6, "fd00::1", 0),
               (socket.AF_INET6, "fe80::1", 1)]
    for family, target, scope in targets:
        for kind, port in [(socket.SOCK_STREAM, 80), (socket.SOCK_STREAM, 443), (socket.SOCK_DGRAM, 443)]:
            try:
                connection = socket.socket(family, kind)
            except OSError as error:
                if family == socket.AF_INET6 and error.errno == errno.EAFNOSUPPORT:
                    continue  # IPv6 may be entirely disabled by the namespace.
                raise
            with connection:
                connection.settimeout(0.5)
                try:
                    connection.connect((target, port, 0, scope) if family == socket.AF_INET6 else (target, port))
                except OSError as error:
                    if error.errno == errno.ENETUNREACH:
                        continue
                    raise
                fail()


def run_qualification():
    with open("/output/qualification.json", "xb") as output:
        subprocess.run(["/usr/local/bin/cognia-desktop-guest", "qualification-importer"],
                       env=ENV, stdin=subprocess.DEVNULL, stdout=output,
                       stderr=subprocess.DEVNULL, timeout=20, check=True)
        output.flush()
        os.fsync(output.fileno())


def main():
    if sys.platform != "linux" or os.getuid() != 1001 or os.getgid() != 1001 or os.getgroups():
        fail()
    os.umask(0o077)
    os.environ.clear()
    signal.signal(signal.SIGALRM, lambda *_: fail())
    signal.alarm(30)
    # No untrusted source is touched until the root supervisor has observed this
    # actual Python process inside all mandatory boundaries.
    admission = sys.stdin.buffer.read(1)
    if admission not in (b"G", b"Q") or sys.stdin.buffer.read(1):
        fail()
    if admission == b"Q":
        # Fixed native payload before any source input; only the root-owned
        # private admission pipe can select this diagnostic. The outer root
        # collector independently validates the actual interpreter boundary.
        run_qualification()
        return
    verify_offline_network()
    raw = Path("/input/request.json").read_bytes()
    if len(raw) > 128 * 1024:
        fail()
    request = strict_json(raw)
    validate(request)
    remaining = min(3600, math.ceil((request["deadlineAtMs"] - time.time() * 1000) / 1000))
    if remaining <= 0:
        fail()
    signal.alarm(remaining)
    import_source(request)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print("managed_handoff_guest_failed", file=sys.stderr)
        sys.exit(1)
