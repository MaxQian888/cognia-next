"""Compile the real Tauri command shell against cached real dependency artifacts.

No Tauri API stubs or copied shell helpers. The actual command/core source is
included, and the existing compiled cognia-agents paths module supplies roots.
A full app build and OS webview IPC integration are separate validation steps.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[3]
deps = repo / "target/debug/deps"
with tempfile.TemporaryDirectory(prefix="cognia-history-shell-") as directory:
    root = Path(directory)
    harness = root / "shell.rs"
    core = repo / "crates/cognia-agent-state/src/session_import.rs"
    shell = repo / "src-tauri/src/session_import.rs"
    harness.write_text(f'''extern crate self as cognia_agent_state;
#[path = "{core}"] pub mod session_import;
pub mod agents {{ pub use cognia_agents::paths; }}
#[path = "{shell}"] mod shell;
#[test] fn shell_uses_real_tauri_version() {{
    assert_eq!(tauri::VERSION, "2.11.5");
    let _command = shell::session_import_fs;
}}
''')
    command = ["rtk", "rustc", "--edition=2021", "--test", str(harness), "--crate-name", "history_fs_shell_verify", "-L", f"dependency={deps}", "-o", str(root / "tests")]
    for name in ["serde", "serde_json", "rusqlite", "dirs", "chrono", "tauri", "cognia_agents"]:
        candidates = list(deps.glob(f"lib{name}-*.rlib"))
        chosen = max(candidates, key=lambda path: path.stat().st_mtime)
        command += ["--extern", f"{name}={chosen}"]
        print("dependency", chosen.name, flush=True)
    print("shell_sha256", hashlib.sha256(shell.read_bytes()).hexdigest(), flush=True)
    print("core_sha256", hashlib.sha256(core.read_bytes()).hexdigest(), flush=True)
    subprocess.run(command, cwd=repo, check=True, env=dict(os.environ, CARGO_PKG_NAME="cognia-next", CARGO_MANIFEST_DIR=str(repo / "src-tauri")))
    subprocess.run(["rtk", str(root / "tests"), "shell", "--nocapture"], cwd=repo, check=True)
