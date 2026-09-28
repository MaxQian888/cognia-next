"""Build actual before/after scanner sources with cached release dependencies and run paired fixtures."""
from pathlib import Path
import os
import sys
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
report = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="cognia-resources-bench-") as scratch:
    binary = str(Path(scratch) / "resources-compare")
    command = ["rustc", "--edition=2021", "-C", "opt-level=3", "-C", "lto=thin", "-C", "linker=src-tauri/scripts/macos-lld-linker.sh", "-L", f"dependency={root / 'target/release/deps'}", str(report / "resources-compare.rs"), "-o", binary]
    for crate in ["serde", "serde_json", "dirs", "tempfile", "base64"]:
        candidates = list((root / "target/release/deps").glob(f"lib{crate}-*.rlib"))
        if not candidates:
            raise RuntimeError("Build release dependencies first: cargo test -p cognia-skills --release --lib --no-run")
        dep = max(candidates, key=lambda path: path.stat().st_mtime_ns)
        command.extend(["--extern", f"{crate}={dep}"])
    subprocess.run(command, cwd=root, check=True)
    if "--memory" in sys.argv:
        for version in ["baseline", "current"]:
            with (report / f"resources-memory-{version}.log").open("w") as output:
                subprocess.run(["/usr/bin/time", "-l", binary], cwd=root, check=True,
                               env={**os.environ, "RESOURCE_VERSION": version},
                               stdout=output, stderr=subprocess.STDOUT)
    else:
        subprocess.run(["/usr/bin/time", "-l", binary], cwd=root, check=True)
