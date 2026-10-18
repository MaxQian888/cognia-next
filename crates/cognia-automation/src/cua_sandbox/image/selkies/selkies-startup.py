"""Run the stock Cognia desktop with a supervised Selkies stream beside it.

The desktop itself is the unchanged `startup.main()`, run in this process so
its computer-server credential handling is exactly the built-in image's. A
thread waits for the X display, then runs Selkies attached to it in Secure
Mode: the Host provisions every session token through `/api/tokens` with the
master token, and nothing else can open a stream.
"""

import ctypes
import importlib.util
import os
import signal
import subprocess
import sys
import threading
import time

SELKIES = "/opt/selkies/bin/selkies"
STARTUP = "/opt/cognia-desktop/startup.py"
TOKEN_ENV = "COGNIA_SELKIES_MASTER_TOKEN"
MAX_RESTARTS = 5
DISPLAY_DEADLINE_S = 60
# Only these reach the Selkies process; the computer-server credential never does.
CHILD_ENV_KEYS = ("DISPLAY", "HOME", "PATH", "XDG_RUNTIME_DIR", "LANG")

# Fixed, not user-tunable. Everything that could move data or input other than
# the stream and the controller's keyboard and mouse is off, and locked where
# Selkies lets a client override it.
FLAGS = (
    "--addr=0.0.0.0",
    "--port=8080",
    "--mode=websockets",
    "--enable-dual-mode=false|locked",
    "--wayland=false",
    "--encoder=h264enc,jpeg",
    "--use-cpu=true",
    "--framerate=30,8-30",
    "--enable-resize=false|locked",
    "--enable-collab=false|locked",
    "--enable-basic-auth=false",
    "--enable-https=false",
    "--audio-enabled=false|locked",
    "--microphone-enabled=false|locked",
    "--webcam-enabled=false|locked",
    "--gamepad-enabled=false|locked",
    "--enable-clipboard=false",
    "--enable-binary-clipboard=false|locked",
    "--clipboard-seamless=false|locked",
    "--file-transfers=none",
    "--printing-enabled=false|locked",
    "--command-enabled=false|locked",
    "--enable-sharing=false|locked",
    "--enable-shared=false|locked",
    "--enable-player2=false|locked",
    "--enable-player3=false|locked",
    "--enable-player4=false|locked",
    "--second-screen=false|locked",
    "--ui-sidebar-show-files=false",
    "--ui-sidebar-show-apps=false",
    "--ui-sidebar-show-sharing=false",
    "--ui-sidebar-show-clipboard=false",
    "--ui-sidebar-show-gamepads=false",
    "--ui-sidebar-show-webcam=false",
    "--ui-sidebar-show-audio-settings=false",
)


def selkies_argv():
    return [SELKIES, *FLAGS]


def selkies_env(token, environ):
    env = {key: environ[key] for key in CHILD_ENV_KEYS if key in environ}
    env["SELKIES_MASTER_TOKEN"] = token
    return env


def pop_master_token(environ):
    token = environ.pop(TOKEN_ENV, "")
    if len(token) != 64 or any(char not in "0123456789abcdef" for char in token):
        raise RuntimeError("Missing private stream credential")
    return token


def display_ready():
    return subprocess.run(["xdpyinfo"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


class StreamSupervisor:
    """Start Selkies once the display answers; restart it with backoff."""

    def __init__(self, token, environ, popen=subprocess.Popen, ready=display_ready,
                 sleep=time.sleep, now=time.monotonic, killpg=os.killpg):
        self._argv = selkies_argv()
        self._env = selkies_env(token, environ)
        self._popen = popen
        self._ready = ready
        self._sleep = sleep
        self._now = now
        self._killpg = killpg
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._child = None
        self.restarts = 0

    def run(self):
        deadline = self._now() + DISPLAY_DEADLINE_S
        while not self._ready():
            if self._stopping.is_set():
                return
            if self._now() >= deadline:
                print("Selkies stream not started: the display never became ready", file=sys.stderr)
                return
            self._sleep(0.2)
        while not self._stopping.is_set():
            with self._lock:
                if self._stopping.is_set():
                    return
                self._child = self._popen(self._argv, env=self._env, start_new_session=True, close_fds=True)
                child = self._child
            child.wait()
            if self._stopping.is_set():
                return
            self.restarts += 1
            if self.restarts > MAX_RESTARTS:
                # The desktop keeps running; viewers fall back to snapshots.
                print("Selkies stream stopped after repeated failures", file=sys.stderr)
                return
            self._sleep(min(30, 2 ** self.restarts))

    def stop(self):
        self._stopping.set()
        with self._lock:
            child = self._child
        if child is None or child.poll() is not None:
            return
        self._signal(child, signal.SIGTERM)
        deadline = self._now() + 3
        while child.poll() is None and self._now() < deadline:
            self._sleep(0.05)
        if child.poll() is None:
            self._signal(child, signal.SIGKILL)

    def _signal(self, child, number):
        try:
            self._killpg(child.pid, number)
        except ProcessLookupError:
            pass


def main():
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        raise RuntimeError("Could not protect desktop startup credentials")
    if sys.argv[1:]:
        raise RuntimeError("Invalid desktop startup mode")
    token = pop_master_token(os.environ)
    spec = importlib.util.spec_from_file_location("cognia_desktop_startup", STARTUP)
    startup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(startup)
    supervisor = StreamSupervisor(token, dict(os.environ))
    threading.Thread(target=supervisor.run, name="selkies", daemon=True).start()
    try:
        startup.main()
    finally:
        supervisor.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Cognia desktop startup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
