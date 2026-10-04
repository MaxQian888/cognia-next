"""Start the native X11 desktop before importing computer-server handlers."""

import ctypes
import importlib.util
import os
import selectors
import signal
import shutil
import subprocess
import sys
import time


def main():
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        raise RuntimeError("Could not protect desktop startup credentials")
    token = os.environ.pop("COGNIA_CUA_AUTH_TOKEN", "")
    if len(token) != 64:
        raise RuntimeError("Missing private desktop server credential")
    menu = os.path.join(os.environ["HOME"], ".config", "openbox", "menu.xml")
    os.makedirs(os.path.dirname(menu), exist_ok=True)
    if not os.path.exists(menu):
        shutil.copyfile("/opt/cognia-desktop/menu.xml", menu)
    children = []
    stopped = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def start(argv, **options):
        child = subprocess.Popen(argv, start_new_session=True, **options)
        children.append(child)
        return child

    try:
        bus = start(["dbus-daemon", "--session", "--nofork", "--print-address=1"], stdout=subprocess.PIPE)
        with selectors.DefaultSelector() as readiness:
            readiness.register(bus.stdout, selectors.EVENT_READ)
            if not readiness.select(5):
                raise RuntimeError("Desktop session bus failed to become ready")
            address = bus.stdout.readline(4096).decode().strip()
            if not address.startswith("unix:"):
                raise RuntimeError("Desktop session bus returned an invalid address")
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = address
        display = start(["Xvfb", ":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac", "-noreset"])
        deadline = time.monotonic() + 15
        while subprocess.run(["xdpyinfo"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            if stopped or display.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("X11 display failed to become ready")
            time.sleep(0.1)
        # pynput sends printable Unicode keys through XSendEvent. xterm rejects
        # those by default, so allow them within this isolated X11 desktop.
        subprocess.run(["xrdb", "-merge"], input=b"XTerm*allowSendEvents: true\n", check=True)
        manager = start(["openbox", "--sm-disable"])
        subprocess.run(["xsetroot", "-solid", "#17202d"], check=True)
        start(["xterm", "-xrm", "XTerm*allowSendEvents: true", "-title", "Cognia Terminal", "-geometry", "88x14+20+470"])
        start(["chromium", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
               "--no-first-run", "--no-default-browser-check", "--window-position=20,20",
               "--window-size=1000,580", "about:blank"])
        spec = importlib.util.spec_from_file_location("cognia_desktop_server", "/opt/cognia-desktop/server.py")
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)

        def should_stop():
            for child in children:
                child.poll()
            return stopped or any(child.returncode is not None for child in [bus, display, manager])

        # Serve in this original nondumpable process. exec() would reset
        # dumpability and briefly expose a token passed in a child's env.
        server.serve(token, should_stop)
        if not stopped and any(child.poll() is not None for child in [bus, display, manager]):
            raise RuntimeError("A required desktop service exited; restart the sandbox")
    finally:
        for child in reversed(children):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 3
        while any(child.poll() is None for child in children) and time.monotonic() < deadline:
            time.sleep(0.05)
        for child in children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Cognia desktop startup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
