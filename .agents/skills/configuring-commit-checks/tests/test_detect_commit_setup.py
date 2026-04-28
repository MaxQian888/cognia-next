from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class DetectCommitSetupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.script = (
            Path(__file__).resolve().parents[1] / "scripts" / "detect_commit_setup.py"
        )

    def make_repo(self, files: dict[str, str], nested: str | None = None) -> tuple[Path, Path]:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        repo_root = Path(temp_dir.name)
        (repo_root / ".git").mkdir()

        for relative_path, content in files.items():
            target = repo_root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        start_path = repo_root
        if nested:
            start_path = repo_root / nested
            start_path.mkdir(parents=True, exist_ok=True)

        return repo_root, start_path

    def run_cli(self, project_root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.script), "--project-root", str(project_root), "--json"],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_node_repo_without_hooks_recommends_husky(self) -> None:
        repo_root, _ = self.make_repo(
            {
                "package.json": json.dumps(
                    {
                        "name": "demo-node",
                        "scripts": {"lint": "eslint ."},
                    }
                )
            }
        )

        result = self.run_cli(repo_root)
        payload = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["project_type"], "node")
        self.assertEqual(payload["recommended_tool"], "husky")
        self.assertEqual(payload["recommendation"], "add-default")

    def test_python_repo_without_hooks_recommends_pre_commit(self) -> None:
        repo_root, _ = self.make_repo(
            {
                "pyproject.toml": "[project]\nname = 'demo-python'\n",
            }
        )

        result = self.run_cli(repo_root)
        payload = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["project_type"], "python")
        self.assertEqual(payload["recommended_tool"], "pre-commit")
        self.assertEqual(payload["recommendation"], "add-default")

    def test_mixed_repo_without_hooks_recommends_pre_commit(self) -> None:
        repo_root, _ = self.make_repo(
            {
                "package.json": json.dumps({"name": "demo-mixed"}),
                "pyproject.toml": "[project]\nname = 'demo-mixed'\n",
            }
        )

        result = self.run_cli(repo_root)
        payload = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["project_type"], "mixed")
        self.assertEqual(payload["recommended_tool"], "pre-commit")
        self.assertEqual(payload["recommendation"], "add-default")

    def test_existing_husky_is_preserved(self) -> None:
        repo_root, _ = self.make_repo(
            {
                "package.json": json.dumps({"name": "demo-node"}),
                ".husky/pre-commit": "npm test\n",
            }
        )

        result = self.run_cli(repo_root)
        payload = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0)
        self.assertIn("husky", payload["existing_tools"])
        self.assertEqual(payload["recommended_tool"], "husky")
        self.assertEqual(payload["recommendation"], "preserve-existing")

    def test_nested_path_resolves_repo_root_and_preserves_lefthook(self) -> None:
        repo_root, start_path = self.make_repo(
            {
                "package.json": json.dumps({"name": "demo-node"}),
                "lefthook.yml": "pre-commit:\n  commands: {}\n",
            },
            nested="apps/web/src",
        )

        result = self.run_cli(start_path)
        payload = json.loads(result.stdout)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["detected_root"], str(repo_root))
        self.assertEqual(payload["recommended_tool"], "lefthook")
        self.assertEqual(payload["recommendation"], "preserve-existing")


if __name__ == "__main__":
    unittest.main()
