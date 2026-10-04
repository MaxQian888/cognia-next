"""CUA exec protocol v1; Python 3 is required inside the desktop image.

The retained desktop is not the command lifetime. Like cognia-sandboxd, this
supervisor owns a session, a renewable lease and cleanup after caller loss.
It is embedded in the host binary, never read from a mutable container file.
"""

import base64
import ctypes
import json
import os
import selectors
import signal
import subprocess
import sys
import threading
import time


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def descendants():
    """Include reparented children after enabling Linux subreaper mode."""
    parents = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/" + entry + "/stat") as stat:
                fields = stat.read().rsplit(")", 1)[1].split()
            parents[int(entry)] = int(fields[1])
        except (FileNotFoundError, ProcessLookupError):
            pass
    owned = {os.getpid()}
    while True:
        found = {pid for pid, parent in parents.items() if parent in owned}
        if found.issubset(owned):
            return owned - {os.getpid()}
        owned.update(found)


def cleanup(process):
    # Keep the group leader unreaped until the first kill to avoid PID reuse.
    if process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    until = time.monotonic() + 2
    while True:
        for pid in descendants():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        # Adopted grandchildren are reaped here; Popen.wait handles the leader.
        process.poll()
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        if not descendants():
            return True
        if time.monotonic() >= until:
            return False
        time.sleep(0.01)


def read_request():
    # Docker may retain the attach pipe after host loss even before the first
    # frame is complete. Bound startup independently of the requested runtime.
    selector = selectors.DefaultSelector()
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ)
    until = time.monotonic() + 10
    data = bytearray()
    try:
        while time.monotonic() < until:
            for _ in selector.select(0.1):
                chunk = os.read(0, 16384)
                if not chunk:
                    raise RuntimeError("caller disconnected before request")
                data.extend(chunk)
                if len(data) > 16 * 1024 * 1024:
                    raise RuntimeError("request exceeds protocol limit")
                if b"\n" in data:
                    return json.loads(data.split(b"\n", 1)[0])
        raise RuntimeError("request startup deadline exceeded")
    finally:
        selector.close()


def main():
    # Validate platform capability before launching any requested command.
    if sys.platform != "linux":
        raise RuntimeError("CUA supervised exec requires Linux /proc and prctl")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "could not enable child subreaper")
    # The command runs under the same guest uid. Deny /proc access to this
    # process's memory and fd table so it cannot write forged protocol frames
    # directly into the supervisor's stdout or inspect the control channel.
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise OSError(ctypes.get_errno(), "could not protect supervisor process")
    descendants()
    # The first message is bounded by the host; no user code is interpolated.
    request = read_request()
    if request.get("probe"):
        emit({"protocol": 1})
        return
    deadline = time.monotonic() + request["timeout_ms"] / 1000
    lease = time.monotonic() + 10
    child_env = {**os.environ, **request.get("env", {})}
    child_env.pop("COGNIA_CUA_AUTH_TOKEN", None)
    process = subprocess.Popen(
        request["argv"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, start_new_session=True,
        env=child_env,
    )
    try:
        execute(process, request, deadline, lease)
    finally:
        # Setup and protocol-output failures must obey the same ownership rule.
        if descendants():
            cleanup(process)


def execute(process, request, deadline, lease):
    # Input can block indefinitely in the child; the supervisor must keep
    # checking its deadline and heartbeat while the writer is backpressured.
    def write_input():
        try:
            process.stdin.write(request["stdin"].encode("utf-8"))
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    writer = threading.Thread(target=write_input, daemon=True)
    writer.start()
    selector = selectors.DefaultSelector()
    for stream, kind in [(process.stdout, "stdout"), (process.stderr, "stderr")]:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, kind)
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ, "heartbeat")
    timed_out = False
    cancelled = False
    code = None
    cleaned = False
    try:
        while True:
            now = time.monotonic()
            timed_out = now >= deadline
            cancelled = now >= lease
            code = process.poll()
            if timed_out or cancelled or code is not None:
                break
            for key, _ in selector.select(min(0.1, max(0, deadline - now))):
                chunk = os.read(key.fd, 16384)
                if key.data == "heartbeat":
                    if not chunk:
                        cancelled = True
                        break
                    lease = time.monotonic() + 10
                elif chunk:
                    emit({key.data: base64.b64encode(chunk).decode("ascii")})
                else:
                    selector.unregister(key.fileobj)
            if cancelled:
                break
    finally:
        cleaned = cleanup(process)
        writer.join(timeout=1)
        # Kill closes inherited pipe writers, so drain remaining bytes before
        # the terminal frame. Read nonblocking: escaped/unreapable processes
        # must never turn cleanup into another unbounded wait.
        for stream, kind in [(process.stdout, "stdout"), (process.stderr, "stderr")]:
            while True:
                try:
                    chunk = os.read(stream.fileno(), 16384)
                except BlockingIOError:
                    cleaned = False
                    break
                if not chunk:
                    break
                emit({kind: base64.b64encode(chunk).decode("ascii")})
        selector.close()
    emit({"exit_code": code if code is not None else -1,
          "timed_out": timed_out, "cancelled": cancelled, "cleaned": cleaned})


try:
    main()
except Exception as error:
    # Docker stderr is transport/supervisor diagnostics, never command stderr.
    print("CUA exec supervisor failed: " + str(error), file=sys.stderr)
    sys.exit(125)
