#!/usr/bin/env python3
"""Exercise PowerShell-specific shell boundaries using the shared HTTP fixture."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import time
import unittest


spec = importlib.util.spec_from_file_location(
    "standalone_contract", Path(__file__).with_name("standalone.test.py")
)
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


class PowerShellRuntimeTests(unittest.TestCase):
    def setUp(self):
        executable = os.environ.get("COGNIA_TEST_PWSH") or shutil.which("pwsh")
        if not executable:
            self.fail("PowerShell is required; set COGNIA_TEST_PWSH or install pwsh")
        fixture_type = type(
            "Fixture", (contract.StandaloneContract, unittest.TestCase),
            {"runtime": "powershell", "executable": executable},
        )
        self.fixture = fixture_type()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()

    def tearDown(self):
        if hasattr(self, "fixture"):
            self.fixture.tearDown()

    def test_recipe_shell_dialect_follows_custom_patch_and_final_override(self):
        case = self.fixture
        patch = case.work / "bash-shell.json"
        patch.write_text(json.dumps({"tools": {"shellExecutable": "bash"}}))
        bash_config, ps_config = case.work / "bash-recipe.json", case.work / "ps-recipe.json"
        case.succeeded(case.invoke("configure", "--recipe", "python-uv", "--preset-file", patch,
                                   "--non-interactive", "--output", bash_config))
        bash_value = json.loads(bash_config.read_text())
        self.assertIn("test -x", bash_value["checks"][0]["command"])
        self.assertEqual(bash_value["tools"]["shellArgs"], ["--noprofile", "--norc"])
        case.succeeded(case.invoke("configure", "--recipe", "python-uv", "--preset-file", patch,
                                   "--set", 'tools.shellExecutable="pwsh"',
                                   "--non-interactive", "--output", ps_config))
        ps_value = json.loads(ps_config.read_text())
        self.assertIn("$IsWindows", ps_value["checks"][0]["command"])
        self.assertEqual(ps_value["tools"]["shellArgs"], ["-NoLogo", "-NoProfile", "-NonInteractive"])
        self.assertEqual(case.requests, [])

    def test_doctor_reports_invalid_config_and_missing_workspace(self):
        case = self.fixture
        case.config["model"]["unexpected"] = True
        report = case.invoke("doctor", "--json")
        self.assertEqual(report.returncode, 1)
        value = json.loads(report.stdout)
        self.assertFalse(value["ok"])
        self.assertEqual(value["checks"][0]["name"], "config")
        del case.config["model"]["unexpected"]
        report = case.invoke("doctor", "--json", "--cwd", case.work / "missing")
        self.assertEqual(report.returncode, 1)
        checks = {check["name"]: check for check in json.loads(report.stdout)["checks"]}
        self.assertFalse(checks["workspace"]["ok"])
        self.assertEqual(case.requests, [])

    def test_model_discovery_rejects_malformed_and_encoded_sensitive_ids(self):
        case = self.fixture
        for payload in (b"not-json", b'{"data":[{"id":"person\\u0040example.com"}]}',
                        json.dumps({"data": [{"id": contract.SYNTHETIC_SECRET}]}).encode()):
            case.respond_get = lambda _path: (200, payload, {})
            result = case.invoke("models", "--json", environment={"AMBIENT_API_KEY": contract.SYNTHETIC_SECRET})
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("person@example.com", result.stdout + result.stderr)
            self.assertNotIn(contract.SYNTHETIC_SECRET, result.stdout + result.stderr)
            self.assertTrue("invalid-models-response" in result.stdout or "privacy-blocked" in result.stdout)

    def test_model_discovery_handles_empty_single_and_oversized_lists(self):
        case = self.fixture
        for models in ([], [{"id": "only-model"}]):
            case.respond_get = lambda _path: (200, {"data": models}, {})
            result = case.invoke("models", "--json")
            case.succeeded(result)
            self.assertEqual(json.loads(result.stdout), [model["id"] for model in models])
        case.config["limits"]["maxResponseBytes"] = 1024
        case.respond_get = lambda _path: (200, {"data": [{"id": "long-" + "x" * 2048}]}, {})
        result = case.invoke("models", "--json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("response-too-large", result.stdout + result.stderr)

    @unittest.skipIf(os.name == "nt", "Directory aliases require Unix symlinks")
    def test_session_resumes_through_parent_alias_but_rejects_leaf_symlink(self):
        case = self.fixture
        alias = case.work / "workspace-alias"
        alias.symlink_to(case.work, target_is_directory=True)
        session = alias / "alias-session.jsonl"
        case.succeeded(case.invoke("run", "--session", session, "--task", "first session turn"))
        case.succeeded(case.invoke("run", "--session", session, "--task", "second session turn"))
        self.assertIn("first session turn", json.dumps(case.requests[-1]["body"]))

        linked_session = case.work / "linked-session.jsonl"
        linked_session.symlink_to(case.work / "alias-session.jsonl")
        before = (case.work / "alias-session.jsonl").read_bytes()
        calls = len(case.requests)
        result = case.invoke("run", "--session", linked_session)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink-path", result.stdout + result.stderr)
        self.assertEqual(calls, len(case.requests))
        self.assertEqual(before, (case.work / "alias-session.jsonl").read_bytes())

    def test_editor_schema_explains_absolute_paths_and_workspace(self):
        case = self.fixture
        case.succeeded(case.invoke())
        body = case.requests[0]["body"]
        schema = next(tool["function"] for tool in body["tools"]
                      if tool["function"]["name"] == "str_replace_editor")
        self.assertIn("absolute", schema["parameters"]["properties"]["path"]["description"].lower())
        self.assertIn(str(case.work), body["messages"][0]["content"])

    @unittest.skipUnless(shutil.which("bash"), "Explicit Bash requires bash")
    def test_explicit_bash_preserves_state_and_stderr(self):
        case = self.fixture
        case.config["tools"].update(
            shellExecutable=shutil.which("bash"), shellArgs=["--noprofile", "--norc"]
        )
        responses = [
            contract.tool("bash", {"command": "export CHECK_MARK=kept; echo stderr-first >&2"}),
            contract.tool("bash", {"command": 'printf "%s" "$CHECK_MARK"; echo stderr-second >&2'}),
            contract.answer("DONE"),
        ]
        case.respond = lambda _body, index: responses[index]
        case.succeeded(case.invoke())
        results = case.tool_results()
        self.assertIn("stderr-first", results[0]["output"])
        self.assertIn("kept", results[1]["output"])
        self.assertIn("stderr-second", results[1]["output"])

    def test_nonterminating_error_fails_readiness(self):
        case = self.fixture
        case.config["checks"] = [{
            "name": "expected-failure",
            "command": 'Write-Error "expected readiness failure"; Write-Output "after error"',
        }]
        case.config["limits"]["maxSteps"] = 1
        case.respond = lambda _body, _index: contract.answer("No fix")
        result = case.invoke("init")
        self.assertNotEqual(result.returncode, 0)
        record = json.loads(result.stdout)
        self.assertFalse(record["checks"][0]["ok"])
        self.assertEqual(record["checks"][0]["exitCode"], 1)
        self.assertNotEqual(record["status"], "ready")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "Named pipes require Unix")
    def test_editor_rejects_fifo_without_blocking(self):
        case = self.fixture
        os.mkfifo(case.work / "named-pipe")
        responses = [
            contract.tool("str_replace_editor", {"command": "view", "path": str(case.work / "named-pipe")}),
            contract.answer("DONE"),
        ]
        case.respond = lambda _body, index: responses[index]
        case.succeeded(case.invoke(timeout=10))
        result = case.tool_results()[0]
        self.assertFalse(result["ok"])
        self.assertIn("not-regular-file", result["output"])

    def test_exiting_native_shell_cleans_up_background_children(self):
        case = self.fixture
        executable = case.executable.replace("'", "''")
        command = (
            f"Start-Process -FilePath '{executable}' -ArgumentList "
            "'-NoLogo','-NoProfile','-Command',"
            "'\"Set-Content -LiteralPath native-started.txt -Value started; "
            "Start-Sleep -Seconds 3; Set-Content -LiteralPath native-detached.txt -Value late\"'; "
            "$deadline = [DateTime]::UtcNow.AddSeconds(3); "
            "while (-not (Test-Path native-started.txt) -and [DateTime]::UtcNow -lt $deadline) "
            "{ Start-Sleep -Milliseconds 20 }; exit 0"
        )
        responses = [contract.tool("bash", {"command": command}), contract.answer("DONE")]
        case.respond = lambda _body, index: responses[index]
        case.succeeded(case.invoke())
        self.assertTrue((case.work / "native-started.txt").exists())
        time.sleep(4)
        self.assertFalse((case.work / "native-detached.txt").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
