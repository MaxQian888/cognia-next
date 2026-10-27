"""Grade retained HTE CEM artifacts without contacting a model.

Keep the original task layout in a private projection, verify all 22 test
identities, and execute only an isolated copy of the candidate package.
"""

import argparse
import ast
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types


HIDDEN_MODULES = {
    "test_q1_pointenv_step": 5,
    "test_q2_cross_entropy_optimize": 7,
    "test_q3_evaluate_plans": 4,
    "test_q4_caching_performance": 3,
}


class GraderError(RuntimeError):
    """Reject incomplete or untrusted grading inputs."""


def digest(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def package_hashes(root: Path) -> dict[str, str]:
    """Hash package sources without following candidate symlinks."""
    if root.is_symlink() or not root.is_dir():
        raise GraderError("Candidate package must be a regular directory")
    result = {}
    for path in sorted(root.rglob("*")):
        if "__pycache__" in path.parts:
            continue
        if path.is_symlink():
            raise GraderError(f"Candidate symlink is not permitted: {path}")
        if path.is_file():
            result[str(path.relative_to(root))] = digest(path)
    if "cross_entropy.py" not in result or "__init__.py" not in result:
        raise GraderError("Candidate CEM package is incomplete")
    return result


def expected_tests(task_dir: Path) -> dict[str, str]:
    """Require the pinned public/hidden test census before executing code."""
    files = {"tests/test_outputs.py": 3}
    files.update({f"evaluation_tests_hidden/{name}.py": n for name, n in HIDDEN_MODULES.items()})
    expected = {}
    for name, count in files.items():
        path = task_dir / name
        if path.is_symlink() or not path.is_file():
            raise GraderError(f"Missing trusted test source: {name}")
        functions = [
            node.name for node in ast.parse(path.read_text()).body
            if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")
        ]
        if len(functions) != count or len(set(functions)) != count:
            raise GraderError(f"Unexpected test census in {name}: {len(functions)} != {count}")
        for function in functions:
            if function in expected:
                raise GraderError(f"Duplicate test identity: {function}")
            expected[function] = name
    return expected


def grader_profile(output: Path, candidate: Path, runtime_roots: list[Path]) -> str:
    """Allow only private grader data and trusted runtime reads under /Users."""
    quote = lambda path: json.dumps(str(path.resolve()))
    readable = [output, candidate, Path(__file__).resolve(), *runtime_roots]
    private_user = '(require-all (subpath "/Users") ' + " ".join(
        f"(require-not (subpath {quote(path)}))" for path in readable
    ) + ")"
    writable = output / "scratch"
    clauses = [
        "(version 1)", "(allow default)",
        f"(deny file-read-data {private_user})",
        f'(deny file-write* (require-all (require-not (subpath {quote(writable)})) '
        '(require-not (literal "/dev/null"))))',
        "(deny network-outbound)", "(deny process-fork)",
    ]
    for boundary in {Path(tempfile.gettempdir()).resolve(), Path("/private/tmp"), Path("/private/var/tmp")}:
        clauses.append(
            f"(deny file-read-data (require-all (subpath {quote(boundary)}) "
            f"(require-not (subpath {quote(output)})) "
            f"(require-not (subpath {quote(candidate)}))))"
        )
    return "\n".join(clauses) + "\n"


def grade(task_dir: Path, workspace: Path, output: Path, python: Path,
          timeout_seconds: float = 180, *, source_hashes: dict[str, str]) -> dict:
    """Grade one retained package in a fresh private result directory.

    Args:
        task_dir (Path): Trusted pinned CEM task directory.
        workspace (Path): Retained agent workspace; never passed to the worker.
        output (Path): New result directory, outside the retained workspace.
        python (Path): Trusted interpreter with pytest and numpy installed.
        timeout_seconds (float): Wall deadline for offline grading.
        source_hashes (dict[str, str]): Trusted source hashes from campaign admission.

    Returns:
        (dict): Separate collection, behavioral and integrity results.
    """
    if sys.platform != "darwin":
        raise GraderError("This grader requires the macOS sandbox-exec boundary")
    task_dir, workspace, output = task_dir.resolve(), workspace.resolve(), output.resolve()
    if output.is_relative_to(workspace) or workspace.is_relative_to(output):
        raise GraderError("Grading output must be separate from retained workspace")
    if output.is_relative_to(task_dir) or task_dir.is_relative_to(output):
        raise GraderError("Grading output must be separate from trusted task sources")
    if not 0 < timeout_seconds <= 180:
        raise GraderError("Grader deadline must be positive and at most180 seconds")
    expected = expected_tests(task_dir)
    if (set(source_hashes) != set(expected.values())
            or any(digest(task_dir / name) != value for name, value in source_hashes.items())):
        raise GraderError("Trusted test sources do not match the admitted manifest")
    source = workspace / "cross_entropy_method"
    before = package_hashes(source)
    output.mkdir(parents=True, exist_ok=False)
    candidate = output / "candidate"
    package = candidate / "cross_entropy_method"
    package.mkdir(parents=True)
    for name in before:
        destination = package / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, destination)
    projection, scratch = output / "task", output / "scratch"
    scratch.mkdir()
    trusted_hashes = {}
    for name in sorted(set(expected.values())):
        destination = projection / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = (task_dir / name).read_bytes()
        if name == "tests/test_outputs.py":
            data = data.decode().replace("/app", str(candidate)).replace(
                "/tests", str(projection / "tests")
            ).encode()
        destination.write_bytes(data)
        trusted_hashes[str(destination)] = digest(destination)
    (output / "pytest.ini").write_text("[pytest]\n")
    metadata_code = (
        "import sys,json,pytest,numpy;print(json.dumps({"
        "'prefix':sys.prefix,'basePrefix':sys.base_prefix,"
        "'pytest':pytest.__file__,'numpy':numpy.__file__,"
        "'pythonVersion':sys.version,'pytestVersion':pytest.__version__,"
        "'numpyVersion':numpy.__version__}))"
    )
    runtime = json.loads(subprocess.check_output(
        [str(python), "-I", "-B", "-c", metadata_code], text=True, timeout=20,
        env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
    ))
    manifest = {"expected": expected, "trustedHashes": trusted_hashes,
                "candidate": str(candidate), "output": str(output), "runtime": runtime,
                "admittedSourceHashes": source_hashes}
    write_json(output / "manifest.json", manifest)
    profile = output / "grader.sb"
    profile.write_text(grader_profile(output, candidate, [Path(runtime["prefix"]), Path(runtime["basePrefix"])]))
    env = {
        "PATH": f"{python.parent}:/usr/bin:/bin", "HOME": str(scratch),
        "TMPDIR": str(scratch), "TEST_DIR": str(scratch / "test_dir"),
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1", "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
    }
    (scratch / "test_dir").mkdir()
    command = ["/usr/bin/sandbox-exec", "-f", str(profile), str(python), "-I", "-B",
               str(Path(__file__).resolve()), "_worker", str(output / "manifest.json")]
    started = time.monotonic()
    child = subprocess.Popen(command, cwd=scratch, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = child.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        stdout, stderr = child.communicate(timeout=10)
    (output / "stdout.log").write_text(stdout)
    (output / "stderr.log").write_text(stderr)
    worker_file = scratch / "worker-result.json"
    worker = json.loads(worker_file.read_text()) if worker_file.exists() else {}
    source_unchanged = package_hashes(source) == before
    candidate_unchanged = package_hashes(package) == before
    tests_unchanged = all(digest(Path(name)) == value for name, value in trusted_hashes.items())
    originals_unchanged = all(digest(task_dir / name) == value for name, value in source_hashes.items())
    collected = worker.get("collected", [])
    names_complete = Counter(name.rsplit("::", 1)[-1] for name in collected) == Counter(expected.keys())
    reports = worker.get("reports", [])
    complete_phases = all(
        Counter(report["phase"] for report in reports if report["nodeid"] == nodeid)
        == {"setup": 1, "call": 1, "teardown": 1} for nodeid in collected
    )
    result = {**worker, "version": 3, "timeoutSeconds": timeout_seconds,
              "timedOut": timed_out, "returnCode": child.returncode,
              "wallSeconds": time.monotonic()-started, "retainedPackageUnchanged": source_unchanged,
              "candidateCopyUnchanged": candidate_unchanged, "trustedTestsUnchanged": tests_unchanged,
              "admittedSourcesUnchanged": originals_unchanged,
              "expectedTests": len(expected), "modelCalls": 0}
    result["validGrading"] = bool(
        not timed_out and child.returncode in {0, 1} and worker.get("collectionComplete")
        and worker.get("sessionFinished") and names_complete and complete_phases
        and source_unchanged and candidate_unchanged and tests_unchanged and originals_unchanged
    )
    result["behavioralPass"] = bool(
        result["validGrading"] and child.returncode == 0
        and worker.get("counts") == {"passed": len(expected)}
    )
    write_json(output / "result.json", result)
    return result


def worker(manifest_file: Path) -> int:
    """Load trusted dependencies before candidate imports and enforce collection."""
    import pytest
    import numpy

    manifest = json.loads(manifest_file.read_text())
    output = Path(manifest["output"])
    expected = manifest["expected"]
    result = {"collectionComplete": False, "collected": [], "reports": [], "counts": {}}
    trusted_code = {}
    for name in manifest["trustedHashes"]:
        module_code = compile(Path(name).read_bytes(), name, "exec", dont_inherit=True)
        for code in module_code.co_consts:
            if isinstance(code, types.CodeType) and code.co_name in expected:
                trusted_code[code.co_name] = code
    if Path(pytest.__file__).resolve() != Path(manifest["runtime"]["pytest"]).resolve():
        raise GraderError("Trusted pytest origin changed")
    if Path(numpy.__file__).resolve() != Path(manifest["runtime"]["numpy"]).resolve():
        raise GraderError("Trusted numpy origin changed")
    sys.path.insert(0, manifest["candidate"])

    class CollectionContract:
        def pytest_collection_modifyitems(self, session, config, items):
            actual = [item.name for item in items]
            result["collected"] = [item.nodeid for item in items]
            errors = []
            if Counter(actual) != Counter(expected.keys()):
                errors.append(f"Expected22 identities, collected{len(items)}: {actual}")
            for item in items:
                name = expected.get(item.name)
                if name is None:
                    continue
                trusted = (output / "task" / name).resolve()
                module = sys.modules.get(item.obj.__module__)
                if (Path(item.obj.__code__.co_filename).resolve() != trusted
                        or module is None or Path(module.__file__).resolve() != trusted):
                    errors.append(f"Untrusted test origin: {item.nodeid}")
                if item.obj.__code__ != trusted_code[item.name]:
                    errors.append(f"Untrusted test bytecode: {item.nodeid}")
            for name, value in manifest["trustedHashes"].items():
                if digest(Path(name)) != value:
                    errors.append(f"Trusted source changed: {name}")
            result["collectionErrors"] = errors
            if errors:
                write_json(output / "scratch/worker-result.json", result)
                raise pytest.UsageError("; ".join(errors))
            result["collectionComplete"] = True
            write_json(output / "scratch/worker-result.json", result)

        def pytest_runtest_logstart(self, nodeid, location):
            result["activeTest"] = nodeid
            result["activeTestStartedEpoch"] = time.time()
            write_json(output / "scratch/worker-result.json", result)

        def pytest_runtest_logreport(self, report):
            result["reports"].append({"nodeid": report.nodeid, "phase": report.when,
                                      "outcome": report.outcome, "seconds": report.duration,
                                      "failure": report.longreprtext if report.failed else None})
            write_json(output / "scratch/worker-result.json", result)

    exit_code = pytest.main([
        str(output / "task/tests/test_outputs.py"), "-q", "-rA", "--tb=short", "--durations=22",
        "--assert=plain",
        "-c", str(output / "pytest.ini"), "--rootdir", str(output),
        "--confcutdir", str(output), "--noconftest", "-p", "no:cacheprovider",
    ], plugins=[CollectionContract()])
    outcomes = {}
    for report in result["reports"]:
        if report["phase"] == "call" or report["outcome"] in {"failed", "skipped"}:
            outcomes[report["nodeid"]] = report["outcome"]
    result["counts"] = dict(Counter(outcomes.values()))
    result["pytestExitCode"] = int(exit_code)
    result["sessionFinished"] = True
    write_json(output / "scratch/worker-result.json", result)
    return int(exit_code)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scoring = commands.add_parser("grade")
    for name in ["task-dir", "workspace", "output-dir", "python"]:
        scoring.add_argument(f"--{name}", type=Path, required=True)
    scoring.add_argument("--timeout-seconds", type=float, default=180)
    scoring.add_argument("--source-manifest", type=Path, required=True)
    internal = commands.add_parser("_worker")
    internal.add_argument("manifest", type=Path)
    args = parser.parse_args()
    if args.command == "_worker":
        return worker(args.manifest)
    result = grade(args.task_dir, args.workspace, args.output_dir, args.python, args.timeout_seconds,
                   source_hashes=json.loads(args.source_manifest.read_text()))
    print(json.dumps(result))
    return 0 if result["behavioralPass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
