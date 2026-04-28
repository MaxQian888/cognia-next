import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "component_test_map.py"
SPEC = importlib.util.spec_from_file_location("component_test_map", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ComponentTestMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="component-test-map-"))
        self.addCleanup(lambda: shutil.rmtree(self.temp_dir, ignore_errors=True))

    def write_file(self, rel_path: str, content: str = "") -> None:
        path = self.temp_dir / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_audit_mappings_detects_missing_and_orphans(self) -> None:
        self.write_file("src/Button.tsx", "export const Button = () => null;\n")
        self.write_file("src/Card.tsx", "export const Card = () => null;\n")
        self.write_file("src/Button.test.tsx", "test('Button', () => {});\n")
        self.write_file("tests/orphan.test.tsx", "test('orphan', () => {});\n")

        results, missing, orphan_tests = MODULE.audit_mappings(
            root=self.temp_dir,
            component_exts=MODULE.DEFAULT_COMPONENT_EXTS,
            test_exts=MODULE.DEFAULT_TEST_EXTS,
            exclude_dirs=MODULE.DEFAULT_EXCLUDE_DIRS,
        )

        mapped = {result.component.as_posix(): [item.as_posix() for item in result.matched_tests] for result in results}
        self.assertIn("src/Button.tsx", mapped)
        self.assertEqual(mapped["src/Button.tsx"], ["src/Button.test.tsx"])
        self.assertIn(Path("src/Card.tsx"), missing)
        self.assertIn(Path("tests/orphan.test.tsx"), orphan_tests)

    def test_maybe_scaffold_missing_creates_expected_test_file(self) -> None:
        self.write_file("src/widgets/Panel.tsx", "export const Panel = () => null;\n")

        created = MODULE.maybe_scaffold_missing(
            root=self.temp_dir,
            missing_components=[Path("src/widgets/Panel.tsx")],
            test_exts=MODULE.DEFAULT_TEST_EXTS,
            force=False,
        )

        self.assertEqual(created, [Path("src/widgets/Panel.test.tsx")])
        scaffold_path = self.temp_dir / "src/widgets/Panel.test.tsx"
        self.assertTrue(scaffold_path.exists())
        self.assertIn('describe("Panel"', scaffold_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
