import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "check_coverage_threshold.py"
SPEC = importlib.util.spec_from_file_location("check_coverage_threshold", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CheckCoverageThresholdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="coverage-threshold-"))
        self.addCleanup(lambda: shutil.rmtree(self.temp_dir, ignore_errors=True))

    def write_summary(self, payload: dict) -> Path:
        coverage_dir = self.temp_dir / "coverage"
        coverage_dir.mkdir(parents=True, exist_ok=True)
        path = coverage_dir / "coverage-summary.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_parse_summary_json_extracts_metric_percentages(self) -> None:
        path = self.write_summary(
            {
                "total": {
                    "lines": {"pct": 91},
                    "statements": {"pct": 90},
                    "functions": {"pct": 89},
                    "branches": {"pct": 88},
                }
            }
        )

        metrics = MODULE.parse_summary_json(path)

        self.assertEqual(metrics["lines"], 91.0)
        self.assertEqual(metrics["branches"], 88.0)

    def test_cli_fails_when_metric_is_below_threshold(self) -> None:
        self.write_summary(
            {
                "total": {
                    "lines": {"pct": 92},
                    "statements": {"pct": 91},
                    "functions": {"pct": 70},
                    "branches": {"pct": 85},
                }
            }
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--root",
                str(self.temp_dir),
                "--threshold",
                "80",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 1)
        self.assertIn("below_threshold: functions=70.00%", completed.stdout)


if __name__ == "__main__":
    unittest.main()
