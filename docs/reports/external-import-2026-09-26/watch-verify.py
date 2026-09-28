"""Compile the production debounce helpers/tests without the Tauri desktop graph.

Only host glue is excluded: the payload, collector, queue, extension filter,
root filter and their inline tests are copied verbatim from the current source.
The generated source hash is recorded; this is not a full Tauri build.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[3]
source = (repo / "src-tauri/src/session_import_watch.rs").read_text()
text = source
text = text[text.index("use std::collections"):]
for line in ["use notify::{RecommendedWatcher, RecursiveMode, Watcher};\n", "use parking_lot::Mutex;\n", "use tauri::{AppHandle, Emitter};\n", "use std::sync::Arc;\n"]:
    text = text.replace(line, "")
a = text.index("struct ActiveWatcher")
b = text.index("/// The same bounded collector", a)
text = text[:a] + text[b:]
a = text.index("/// Managed Tauri")
b = text.index("/// Whether a changed path", a)
text = text[:a] + text[b:]
a = text.index("/// Start (or replace)")
b = text.index("#[cfg(test)]", a)
text = text[:a] + text[b:]
a = text.index("    #[test]\n    fn stop_is_safe_when_idle")
b = text.index("    #[tokio::test]", a)
text = text[:a] + text[b:]
print("production_sha256", hashlib.sha256(source.encode()).hexdigest(), flush=True)
print("harness_sha256", hashlib.sha256(text.encode()).hexdigest(), flush=True)
with tempfile.TemporaryDirectory(prefix="cognia-watch-verify-") as directory:
    root = Path(directory)
    (root / "src").mkdir()
    (root / "src/lib.rs").write_text(text)
    (root / "Cargo.toml").write_text('''[package]
name = "cognia-watch-verify"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["macros", "rt", "sync", "time"] }
tempfile = "3"
[profile.dev]
debug = 0
''')
    env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target"))
    subprocess.run(["rtk", "cargo", "test", "--offline", "--manifest-path", str(root / "Cargo.toml")], env=env, check=True)
