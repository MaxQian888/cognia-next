"""Bounded guest file operations, embedded in the native host and supervised.

No file is published until complete. O_TMPFILE leaves nothing to clean up if
this process is killed; linkat publishes without replacing an existing name.
"""
import base64
import ctypes
import hashlib
import json
import os
import stat
import sys

MAX_BYTES = 8 * 1024 * 1024
MAX_WIRE = ((MAX_BYTES + 2) // 3) * 4 + 32768


def open_parent(path):
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path or len(path.encode()) > 4096:
        raise ValueError("file path must be an absolute guest path of at most 4096 bytes")
    parts = path.split("/")[1:]
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("file path must not contain empty, dot or parent components")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent, parts[-1]
    except BaseException:
        os.close(parent)
        raise


def strict_bytes(encoded):
    if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError("file exceeds the 8 MiB transfer limit")
    data = base64.b64decode(encoded, validate=True)
    if len(data) > MAX_BYTES or base64.b64encode(data).decode("ascii") != encoded:
        raise ValueError("invalid base64 or file exceeds the 8 MiB transfer limit")
    return data


def upload(parent, name, data):
    if not hasattr(os, "O_TMPFILE"):
        raise OSError("atomic upload requires Linux O_TMPFILE support")
    try:
        fd = os.open(".", os.O_WRONLY | os.O_TMPFILE, 0o600, dir_fd=parent)
    except OSError as error:
        raise OSError("destination filesystem cannot create an anonymous atomic upload") from error
    try:
        remaining = memoryview(data)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("file write made no progress")
            remaining = remaining[written:]
        os.fsync(fd)
        # /proc/self/fd permits unprivileged O_TMPFILE publication; AT_EMPTY_PATH
        # would require CAP_DAC_READ_SEARCH, deliberately absent in the guest.
        libc = ctypes.CDLL(None, use_errno=True)
        linkat = libc.linkat
        linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        linkat.restype = ctypes.c_int
        if linkat(-100, ("/proc/self/fd/" + str(fd)).encode(), parent, os.fsencode(name), 0x400) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        try:
            os.fsync(parent)
        except OSError as error:
            raise OSError("file was published but directory sync failed") from error
    finally:
        os.close(fd)


def download(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("download requires a regular file")
        if before.st_size > MAX_BYTES:
            raise ValueError("file exceeds the 8 MiB transfer limit")
        data = bytearray()
        while True:
            chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_BYTES:
                raise ValueError("file exceeds the 8 MiB transfer limit")
        after = os.fstat(fd)
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if signature(before) != signature(after) or len(data) != after.st_size:
            raise ValueError("file changed during download; retry after it is stable")
        return bytes(data)
    finally:
        os.close(fd)


def main():
    request_bytes = sys.stdin.buffer.read(MAX_WIRE + 1)
    if len(request_bytes) > MAX_WIRE:
        raise ValueError("file request exceeds transfer limit")
    request = json.loads(request_bytes)
    operation = request.get("operation")
    if operation not in ("upload", "download"):
        raise ValueError("unsupported file operation")
    data = strict_bytes(request.get("dataBase64")) if operation == "upload" else None
    parent, name = open_parent(request.get("path"))
    try:
        if operation == "upload":
            upload(parent, name, data)
        else:
            data = download(parent, name)
    finally:
        os.close(parent)
    result = {"path": request["path"], "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if operation == "download":
        result["dataBase64"] = base64.b64encode(data).decode("ascii")
    return result


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": main()}, separators=(",", ":")))
    except Exception as error:
        # Only the guest path/error is returned, never request bodies or bytes.
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
