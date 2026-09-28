"""Compare frozen native SessionStore implementations without changing the checkout.

Run from the repository root with Python 3 and Cargo installed. Builds two small
release test binaries from the actual store module, then runs AB/BA cohorts.
Only temporary file-backed fixtures are written; user databases are never read.
"""

import argparse
import hashlib
import json
import re
import shutil
import statistics
import subprocess
import tempfile
from pathlib import Path


BASE = "f28694466f3a1de25abe2c512385ceef54cce6de"
MODULE = "crates/cognia-agent-state/src/agent_session_store/mod.rs"
MANIFEST = """[package]
name = "cognia-session-store-evidence"
version = "0.1.0"
edition = "2021"
[workspace]
[dependencies]
serde = {version="1", features=["derive"]}
serde_json="1"
rusqlite={version="=0.37.0",features=["bundled","backup"]}
parking_lot="0.12"
once_cell="1"
tokio={version="1",features=["rt","sync"]}
log="0.4"
[profile.release]
debug="line-tables-only"
lto="thin"
codegen-units=1
strip=true
"""


def observed_baseline(source: str, current: str) -> str:
    """Add identical observation hooks and the benchmark to the old store."""
    source = source.replace(
        "    path: Option<PathBuf>,",
        "    path: Option<PathBuf>,\n    #[cfg(test)]\n"
        "    read_started: Mutex<Option<ReadStartSignal>>,",
        1,
    )
    for path in ["Some(path)", "None"]:
        source = source.replace(
            f"            path: {path},",
            f"            path: {path},\n            #[cfg(test)]\n"
            "            read_started: Mutex::new(None),",
            1,
        )
    source = source.replace(
        '            let raw = row.map_err(|e| format!("sessionStore: row: {e}"))?;',
        '            let raw = row.map_err(|e| format!("sessionStore: row: {e}"))?;\n'
        "            #[cfg(test)]\n"
        "            if out.is_empty() { self.notify_read_started(); }",
        1,
    )
    source = source.replace(
        "        guard\n            .backup(rusqlite::MAIN_DB, dest, None)",
        "        #[cfg(test)]\n        self.notify_read_started();\n"
        "        guard\n            .backup(rusqlite::MAIN_DB, dest, None)",
        1,
    )
    source = source.replace(
        "impl SessionStore {",
        "#[cfg(test)]\ntype ReadStartSignal = (std::sync::mpsc::SyncSender<()>, Option<std::sync::mpsc::Receiver<()>>);\n"
        "impl SessionStore {\n    #[cfg(test)]\n"
        "    fn notify_read_started(&self) {\n"
        "        if let Some((started, resume)) = self.read_started.lock().take() {\n"
        "            let _ = started.send(());\n"
        "            if let Some(resume) = resume { resume.recv_timeout(std::time::Duration::from_secs(30)).unwrap(); }\n"
        "        }\n"
        "    }",
        1,
    )
    benchmark = re.search(
        r"    fn benchmark_recovery_contention\(\) \{.*?(?=\n    #\[test\])",
        current,
        re.DOTALL,
    ).group()
    end = source.rfind("}")
    return source[:end] + '\n    #[test]\n    #[ignore = "manual measurement"]\n' + benchmark + source[end:]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[3]
    current = (root / MODULE).read_text()
    original = subprocess.check_output(
        ["rtk", "proxy", "git", "show", f"{BASE}:{MODULE}"], cwd=root, text=True
    )
    sources = {"before": observed_baseline(original, current), "after": current}
    output = {"baselineRevision": BASE, "samplesPerVariant": 20, "order": ["before", "after", "after", "before"]}
    metrics = {name: {} for name in sources}
    rss = {name: [] for name in sources}
    with tempfile.TemporaryDirectory(prefix="cognia-store-evidence-") as working:
        work = Path(working)
        binaries = {}
        for name, source in sources.items():
            package = work / name
            module = package / "src/agent_session_store"
            module.mkdir(parents=True)
            (module / "mod.rs").write_text(source)
            shutil.copyfile(root / MODULE.replace("mod.rs", "dispatch.rs"), module / "dispatch.rs")
            (package / "src/lib.rs").write_text("pub mod agent_session_store;\n")
            (package / "Cargo.toml").write_text(MANIFEST)
            shutil.copyfile(root / "Cargo.lock", package / "Cargo.lock")
            with (args.out / f"{name}-build.log").open("w") as log:
                built = subprocess.run(
                    ["rtk", "proxy", "cargo", "test", "--offline", "--manifest-path", str(package / "Cargo.toml"),
                     "--target-dir", str(work / "target"), "--release", "--no-run", "--message-format=json"],
                    check=True, text=True, stdout=subprocess.PIPE, stderr=log, cwd=root,
                )
            executable = next(
                row["executable"] for line in built.stdout.splitlines()
                if (row := json.loads(line)).get("executable")
            )
            binary = work / f"{name}-test"
            shutil.copyfile(executable, binary)
            binary.chmod(0o700)
            binaries[name] = binary
            (args.out / f"{name}-source.rs").write_text(source)
            output[f"{name}SourceSha256"] = hashlib.sha256(source.encode()).hexdigest()
        for cohort, name in enumerate(output["order"]):
            with (args.out / f"{cohort}-{name}.log").open("w") as log:
                subprocess.run(
                    ["rtk", "proxy", "/usr/bin/time", "-l", str(binaries[name]),
                     "agent_session_store::tests::benchmark_recovery_contention", "--exact", "--ignored",
                     "--nocapture", "--test-threads=1"],
                    check=True, stdout=log, stderr=subprocess.STDOUT, cwd=root, timeout=180,
                )
            raw = (args.out / f"{cohort}-{name}.log").read_text()
            for line in raw.splitlines():
                if "samplesMs" in line:
                    row = json.loads(line[line.index("{"):])
                    metrics[name].setdefault(row["metric"], []).extend(row["samplesMs"])
                    output["sqliteVersion"] = row["sqliteVersion"]
                if "maximum resident set size" in line:
                    rss[name].append(int(line.split()[0]))
        output["peakRssBytes"] = rss
        output["metrics"] = {}
        for metric in metrics["before"]:
            stats = {}
            for name in sources:
                values = metrics[name][metric]
                median = statistics.median(values)
                stats[name] = {"medianMs": median, "madMs": statistics.median(abs(v - median) for v in values), "samplesMs": values}
            delta = stats["before"]["medianMs"] - stats["after"]["medianMs"]
            stats["improvementPercent"] = delta / stats["before"]["medianMs"] * 100
            stats["clearsNoise"] = abs(delta) > 2 * max(stats["before"]["madMs"], stats["after"]["madMs"])
            output["metrics"][metric] = stats
    (args.out / "results.json").write_text(json.dumps(output, indent=2) + "\n")
    print(args.out / "results.json")


if __name__ == "__main__":
    main()
