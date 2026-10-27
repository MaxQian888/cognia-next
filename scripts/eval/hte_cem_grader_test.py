"""Exercise real protected CEM collection, grading and disclosure boundaries."""

import importlib.util
import ast
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("hte_cem_grader", Path(__file__).with_name("hte_cem_grader.py"))
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


@unittest.skipUnless(sys.platform == "darwin", "Requires real sandbox-exec")
class ProtectedCemGraderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cognia-cem-grader-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.task = self.root / "task-source"
        self.workspace = self.root / "retained-workspace"
        (self.task / "tests").mkdir(parents=True)
        (self.task / "evaluation_tests_hidden").mkdir()
        (self.workspace / "cross_entropy_method").mkdir(parents=True)
        self.package = self.workspace / "cross_entropy_method/cross_entropy.py"
        self.package.with_name("__init__.py").write_text("")
        self.package.write_text("def value():\n    return 42\n")
        entry = "from pathlib import Path\nimport importlib,inspect,sys\nfrom cross_entropy_method.cross_entropy import value\n"
        for index in range(3):
            entry += f"def test_public_{index}():\n    assert value()==42\n"
        entry += (
            "hidden=Path(__file__).parent.parent/'evaluation_tests_hidden'\n"
            "if not hidden.exists(): hidden=Path('/app/evaluation_tests_hidden')\n"
            "if hidden.exists():\n    sys.path.insert(0,str(hidden))\n"
            f"    for name in {list(grader.HIDDEN_MODULES)!r}:\n"
            "        try:\n            module=importlib.import_module(name)\n"
            "            for key,fn in inspect.getmembers(module,inspect.isfunction):\n"
            "                if key.startswith('test_'):globals()[key]=fn\n"
            "        except ImportError:pass\n"
            "    sys.path.remove(str(hidden))\n"
        )
        (self.task / "tests/test_outputs.py").write_text(entry)
        for module, count in grader.HIDDEN_MODULES.items():
            text = "from cross_entropy_method.cross_entropy import value\n"
            for index in range(count):
                text += f"def test_{module}_{index}():\n    assert value()==42\n"
            (self.task / "evaluation_tests_hidden" / f"{module}.py").write_text(text)

    def run_grade(self, name="grade"):
        hashes = {str(path.relative_to(self.task)): grader.digest(path)
                  for path in self.task.rglob("*.py")}
        return grader.grade(self.task, self.workspace, self.root / name, Path(sys.executable),
                            source_hashes=hashes)

    def test_collects_exact22_original_origins_and_executes_all(self):
        before = self.package.read_bytes()
        result = self.run_grade()
        self.assertTrue(result["behavioralPass"], (self.root / "grade/stderr.log").read_text())
        self.assertEqual(result["counts"], {"passed": 22})
        self.assertEqual(len(result["collected"]), 22)
        self.assertEqual(result["collectionErrors"], [])
        self.assertEqual(self.package.read_bytes(), before)
        self.assertTrue(result["candidateCopyUnchanged"])

    def test_hidden_assertions_can_fail_when_public_checks_pass(self):
        hidden = self.task / "evaluation_tests_hidden/test_q1_pointenv_step.py"
        hidden.write_text(hidden.read_text().replace("==42", "==43"))
        result = self.run_grade()
        self.assertTrue(result["collectionComplete"])
        self.assertFalse(result["behavioralPass"])
        self.assertEqual(result["counts"], {"passed": 17, "failed": 5})

    def test_original_style_docstrings_do_not_change_code_identity(self):
        for path in self.task.rglob("*.py"):
            tree = ast.parse(path.read_text())
            for node in tree.body:
                if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
                    node.body.insert(0, ast.Expr(value=ast.Constant(
                        "Test that the original behavior is verified.\n\n    Preserve detailed docstrings.\n"
                    )))
            path.write_text(ast.unparse(ast.fix_missing_locations(tree)) + "\n")
        self.assertTrue(self.run_grade()["behavioralPass"])

    def test_missing_hidden_module_fails_before_candidate_execution(self):
        (self.task / "evaluation_tests_hidden/test_q1_pointenv_step.py").unlink()
        with self.assertRaisesRegex(grader.GraderError, "Missing trusted"):
            self.run_grade()

    def test_mutated_admitted_test_source_is_rejected(self):
        hashes = {str(path.relative_to(self.task)): grader.digest(path)
                  for path in self.task.rglob("*.py")}
        path = self.task / "tests/test_outputs.py"
        path.write_text(path.read_text() + "\n# changed after admission\n")
        with self.assertRaisesRegex(grader.GraderError, "admitted manifest"):
            grader.grade(self.task, self.workspace, self.root / "grade", Path(sys.executable),
                         source_hashes=hashes)

    def test_swallowed_hidden_import_error_fails_collection_contract(self):
        hidden = self.task / "evaluation_tests_hidden/test_q1_pointenv_step.py"
        hidden.write_text("import missing_cem_test_dependency\n" + hidden.read_text())
        result = self.run_grade()
        self.assertFalse(result["behavioralPass"])
        self.assertFalse(result["collectionComplete"])
        self.assertIn("Expected22", " ".join(result["collectionErrors"]))

    def test_denied_hidden_read_fails_closed(self):
        original = grader.grader_profile

        def deny_one(output, candidate, roots):
            path = output / "task/evaluation_tests_hidden/test_q1_pointenv_step.py"
            return original(output, candidate, roots) + f'(deny file-read-data (literal {json.dumps(str(path))}))\n'

        with patch.object(grader, "grader_profile", side_effect=deny_one):
            result = self.run_grade()
        self.assertFalse(result["behavioralPass"])
        self.assertFalse(result.get("collectionComplete", False))

    def test_workspace_startup_and_dependency_shadows_are_not_executed(self):
        for name in ["pytest.py", "numpy.py", "sitecustomize.py", "conftest.py"]:
            (self.workspace / name).write_text("raise RuntimeError('HOSTILE_WORKSPACE_STARTUP')\n")
        (self.workspace / "pytest.ini").write_text("[pytest]\naddopts = --unknown-option\n")
        self.assertTrue(self.run_grade()["behavioralPass"])

    def test_candidate_cannot_write_hidden_source_back_or_make_network_calls(self):
        listener = socket.socket()
        self.addCleanup(listener.close)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(0.1)
        port = listener.getsockname()[1]
        leak = self.workspace / "hidden-leak.txt"
        self.package.write_text(
            "from pathlib import Path\nimport socket\n"
            "def value():\n"
            "    source=Path(__file__).parents[2]/'task/evaluation_tests_hidden/test_q1_pointenv_step.py'\n"
            "    text=source.read_text()\n"
            f"    try:Path({str(leak)!r}).write_text(text)\n"
            "    except PermissionError:print('WRITEBACK_DENIED')\n"
            "    else:raise AssertionError('WRITEBACK_ALLOWED')\n"
            f"    try:socket.create_connection(('127.0.0.1',{port}),timeout=.1)\n"
            "    except PermissionError:print('NETWORK_DENIED')\n"
            "    else:raise AssertionError('NETWORK_ALLOWED')\n"
            "    return 42\n"
        )
        result = self.run_grade()
        self.assertTrue(result["behavioralPass"], (self.root / "grade/stdout.log").read_text())
        self.assertFalse(leak.exists())
        self.assertEqual(result["modelCalls"], 0)
        with self.assertRaises(socket.timeout):
            listener.accept()

    def test_fake_hidden_modules_fail_test_origin_validation(self):
        self.package.write_text(
            "import types,sys\n"
            f"for name,count in {grader.HIDDEN_MODULES!r}.items():\n"
            "    module=types.ModuleType(name)\n    module.__file__=__file__\n"
            "    for i in range(count):\n"
            "        exec('def test_'+name+'_'+str(i)+'():pass',module.__dict__)\n"
            "    sys.modules[name]=module\n"
            "def value():return 42\n"
        )
        result = self.run_grade()
        self.assertFalse(result["behavioralPass"])
        self.assertIn("Untrusted test origin", " ".join(result["collectionErrors"]))

    def test_forged_trusted_filename_does_not_make_empty_tests_trusted(self):
        self.package.write_text(
            "import types,sys\nfrom pathlib import Path\n"
            "hidden=Path(__file__).parents[2]/'task/evaluation_tests_hidden'\n"
            f"for name,count in {grader.HIDDEN_MODULES!r}.items():\n"
            "    module=types.ModuleType(name)\n    module.__file__=str(hidden/(name+'.py'))\n"
            "    source='\\n'.join('def test_'+name+'_'+str(i)+'():pass' for i in range(count))\n"
            "    exec(compile(source,module.__file__,'exec'),module.__dict__)\n"
            "    sys.modules[name]=module\n"
            "def value():return 42\n"
        )
        result = self.run_grade()
        self.assertFalse(result["behavioralPass"])

    def test_forged_counts_then_early_process_exit_is_not_a_pass(self):
        self.package.write_text(
            "import json,os\nfrom pathlib import Path\n"
            "output=Path(__file__).parents[2]\n"
            "(output/'scratch/worker-result.json').write_text(json.dumps("
            "{'collectionComplete':True,'counts':{'passed':22}}))\n"
            "os._exit(0)\n"
        )
        self.assertFalse(self.run_grade()["behavioralPass"])

    def test_deadline_terminates_candidate_without_promoting_partial_results(self):
        self.package.write_text("import time\ndef value():\n    time.sleep(5)\n    return 42\n")
        hashes = {str(path.relative_to(self.task)): grader.digest(path)
                  for path in self.task.rglob("*.py")}
        result = grader.grade(self.task, self.workspace, self.root / "grade", Path(sys.executable),
                              timeout_seconds=0.4, source_hashes=hashes)
        self.assertTrue(result["timedOut"])
        self.assertFalse(result["validGrading"])
        self.assertFalse(result["behavioralPass"])
        self.assertTrue(result["retainedPackageUnchanged"])

    def test_rejects_symlink_candidate_and_existing_output(self):
        (self.workspace / "cross_entropy_method/alias.py").symlink_to(self.package)
        with self.assertRaisesRegex(grader.GraderError, "symlink"):
            self.run_grade()
        (self.workspace / "cross_entropy_method/alias.py").unlink()
        (self.root / "grade").mkdir()
        with self.assertRaises(FileExistsError):
            self.run_grade()


if __name__ == "__main__":
    unittest.main()
