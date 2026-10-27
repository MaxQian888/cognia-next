"""Add liveness signals to the exact pinned Selkies client during image build."""

import hashlib
import importlib.resources
from pathlib import Path
import shutil

CORE_SHA256 = "3a2199dfa2535eb0ad077e6413df11ef57b944e802209788d140c2194e2e1519"
ENTRY_SHA256 = "280838b7855947623b8539ae37d28fee55ee74f6c4c1a22d70d1e8121f3fdece"
ENTRY_ASSET = Path("assets/index-CPWh3fQ6.js")
CORE_ASSET = Path("assets/selkies-core-BbKps5RD.js")
CORE_IMPORT = 'import(`./selkies-core-BbKps5RD.js`)'
MODULE_TAG = '<script type="module" crossorigin src="./assets/index-CPWh3fQ6.js"></script>'
SIGNALS = (
    ("Ee=performance.now()", 2, "received"),
    ("k=performance.now()", 4, "output"),
    ("console.log(`[websockets] Connection opened!`)", 1, "connected"),
    ("console.error(`[websockets] Error:`,e)", 1, "error"),
    ("console.log(`[websockets] Connection closed`,e)", 1, "closed"),
    ("window.isFallingBack=!0", 1, "decoder-failed"),
    ("console.error(`Received KILL message from server: ${e}`)", 1, "killed"),
)


def instrument_core(content):
    """Refuse package drift before instrumenting decoded/display-path progress."""
    if hashlib.sha256(content).hexdigest() != CORE_SHA256:
        raise RuntimeError("Unexpected Selkies client bundle; review liveness integration before building")
    source = content.decode("utf-8")
    for marker, count, signal in SIGNALS:
        if source.count(marker) != count:
            raise RuntimeError(f"Unexpected Selkies liveness anchor count: {signal}")
        replacement = f'({marker},window.dispatchEvent(new Event("cognia-selkies-{signal}")))'
        source = source.replace(marker, replacement)
    return source


def prepare_web_root(source, destination):
    """Copy the stock UI and load the liveness bridge before its module."""
    entry = (source / ENTRY_ASSET).read_bytes()
    if hashlib.sha256(entry).hexdigest() != ENTRY_SHA256 or entry.decode().count(CORE_IMPORT) != 1:
        raise RuntimeError("Unexpected Selkies runtime import; review liveness integration before building")
    core = instrument_core((source / CORE_ASSET).read_bytes())
    index = (source / "index.html").read_text()
    if index.count(MODULE_TAG) != 1:
        raise RuntimeError("Unexpected Selkies entry point; cannot install liveness bridge")
    shutil.copytree(source, destination, dirs_exist_ok=True)
    (destination / CORE_ASSET).write_text(core)
    (destination / "index.html").write_text(index.replace(
        MODULE_TAG, '<script src="./cognia-stream-health.js"></script>\n' + MODULE_TAG))
    shutil.copyfile(Path(__file__).with_name("stream-health.js"), destination / "cognia-stream-health.js")


if __name__ == "__main__":
    prepare_web_root(
        Path(str(importlib.resources.files("selkies.selkies_web"))),
        Path("/opt/cognia-desktop/selkies-web"),
    )
