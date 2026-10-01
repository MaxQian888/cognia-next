#!/usr/bin/env python3
"""Black-box native Bash contracts. Python is the test runner, never the agent runtime."""
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("standalone_contract", HERE / "standalone.test.py")
contracts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contracts)

class NativeBoundaryTests(contracts.StandaloneContract, unittest.TestCase):
    runtime = "bash"
    executable = "/bin/bash"

    def test_chat_model_listing_budget_starts_after_user_input(self):
        self.config["limits"]["totalTimeoutSecs"] = 2
        self.config_path.write_text(json.dumps(self.config))
        process = subprocess.Popen(self.command("chat", "--config", self.config_path,
                                   "--cwd", self.work, "--no-session"), cwd=self.work,
                                   env=self.environment, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.read(2), "> ")
            time.sleep(3)
            stdout, stderr = process.communicate("/models\n/quit\n", timeout=10)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        self.assertEqual(process.returncode, 0, stderr)
        self.assertNotIn("time-budget-exhausted", stderr)
        self.assertIn("a-model", stdout)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0]["method"], "GET")

    def test_custom_preset_rejects_multiple_documents_and_oversize(self):
        patch = self.work / "custom.json"
        output = self.work / "export.json"
        for content in ['{}\n{}', '{"task":"' + 'x' * 1048576 + '"}']:
            with self.subTest(size=len(content)):
                patch.write_text(content)
                result = self.invoke("configure", "--non-interactive", "--preset-file", patch,
                                     "--output", output)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
                self.assertEqual(self.requests, [])

    def test_recipe_uses_final_custom_shell_for_export(self):
        patch = self.work / "custom.json"
        patch.write_text(json.dumps({"tools": {"shellExecutable": "pwsh", "shellArgs": []}}))
        output = self.work / "export.json"
        self.succeeded(self.invoke("configure", "--non-interactive", "--recipe", "node-pnpm",
                                   "--preset-file", patch, "--output", output))
        config = json.loads(output.read_text())
        self.assertIn("Test-Path", config["checks"][0]["command"])
        self.assertEqual(config["tools"]["shellExecutable"], "pwsh")
        self.assertFalse((self.work / "node_modules").exists())
        self.assertEqual(self.requests, [])

    def test_powershell_execution_reports_native_runtime_requirement(self):
        self.config["tools"].update(shellExecutable="pwsh", shellArgs=[])
        result = self.invoke("doctor", "--json")
        self.assertEqual(result.returncode, 1)
        checks = json.loads(result.stdout)["checks"]
        self.assertFalse(next(check for check in checks if check["name"] == "shell")["ok"])
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["errorCode"], "unsupported-shell")
        self.assertEqual(self.requests, [])

    def test_chat_rejects_invalid_model_without_changing_next_turn(self):
        result = self.invoke("chat", "--no-session", stdin="/model \n/model safe-model\n/model synthetic@example.com\nhello\n/quit\n")
        self.succeeded(result)
        self.assertEqual(self.requests[-1]["body"]["model"], "safe-model")
        self.assertIn("outbound-pii-blocked", result.stderr)
        self.assertNotIn("synthetic@example.com", result.stdout)

    def test_invalid_nested_credentials_and_unknown_fields(self):
        for override in ['model.apiKey="hidden"', 'model.thinking={"credentials":{"api_key":"hidden"}}',
                         'model.extraBody.extension="{\\"password\\":\\"hidden\\"}"',
                         'tools.environment.BASH_ENV="/tmp/inject"',
                         'model.headers.Authorization="inline"', 'context.autoCompact="false"',
                         'model.endpointPath="../escape"', 'reuse.outputs=["../escape"]']:
            with self.subTest(override=override):
                self.assertNotEqual(self.invoke("run", "--set", override).returncode, 0)
                self.assertEqual(self.requests, [])

    def test_all_calls_are_validated_before_any_execute(self):
        marker = self.work / "forbidden"
        self.respond = lambda _body, _index: {"role":"assistant","content":None,"tool_calls":[
            {"id":"a","type":"function","function":{"name":"bash","arguments":'{"command":"touch forbidden"}'}},
            {"id":"b","type":"function","function":{"name":"bash","arguments":'{"command":null}'}}]}
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(marker.exists())

    def test_duplicate_tool_ids_are_rejected(self):
        call = contracts.tool("bash", {"command":"touch forbidden"})
        call["tool_calls"] *= 2
        self.respond = lambda _body, _index: call
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse((self.work / "forbidden").exists())

    def test_editor_fifo_is_rejected_without_blocking(self):
        import os
        os.mkfifo(self.work / "fifo")
        self.respond = lambda _body, index: contracts.tool("str_replace_editor", {
            "command":"view","path":str(self.work / "fifo")}) if index == 0 else contracts.answer()
        self.succeeded(self.invoke(timeout=15))
        self.assertIsNone(self.tool_results()[-1]["exitCode"])

    def test_configuration_overwrite_requires_force_and_is_private(self):
        self.config_path.write_text("original")
        base = self.command("configure", "--non-interactive", "--output", self.config_path)
        refused = subprocess.run(base, env=self.environment, capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(self.config_path.read_text(), "original")
        self.succeeded(subprocess.run([*base, "--force"], env=self.environment, capture_output=True, text=True))
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)

    def test_literal_credentials_in_static_headers_are_gated(self):
        self.config["model"]["headers"] = {"X-Ordinary": contracts.SYNTHETIC_SECRET}
        self.config["model"]["apiKeyEnv"] = "TEST_PRIVATE_KEY"
        self.assertNotEqual(self.invoke(environment={"TEST_PRIVATE_KEY":contracts.SYNTHETIC_SECRET}).returncode, 0)
        self.assertEqual(self.requests, [])

    def test_normalized_and_encoded_private_values_are_gated(self):
        for value in ['synthetic@example.com', 'sk-proj-abcdefgh\x1b[0mijklmnop12345678',
                      'ghp_abcdefghij\u202Eklmnopqrst1234', '{"nested":"synthetic@example.com"}']:
            with self.subTest(value=value):
                self.assertNotEqual(self.invoke("run", "--task", value).returncode, 0)
                self.assertEqual(self.requests, [])

    def test_invalid_boolean_cli_is_a_clean_error(self):
        result = self.invoke("run", "--stream", "maybe")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)

    def test_dsh_path_contract_is_visible_to_the_model(self):
        self.succeeded(self.invoke())
        body = self.requests[0]['body']
        self.assertIn(str(self.work), body['messages'][0]['content'])
        editor = next(item['function'] for item in body['tools']
                      if item['function']['name'] == 'str_replace_editor')
        self.assertIn('Absolute path', editor['parameters']['properties']['path']['description'])

    def test_workspace_context_resolves_omitted_and_relative_cwd(self):
        self.config_path.write_text(json.dumps(self.config))
        for arguments in [[], ['--cwd', '.']]:
            with self.subTest(arguments=arguments):
                result = subprocess.run(self.command('run', '--config', self.config_path, *arguments),
                                        cwd=self.work, env=self.environment, capture_output=True,
                                        text=True, timeout=15)
                self.succeeded(result)
                persona = self.requests[-1]['body']['messages'][0]['content']
                self.assertIn('Workspace root: ' + json.dumps(str(self.work)), persona)

    def test_sse_crlf_and_multiline_data_events(self):
        self.config['model']['stream'] = True
        event = json.dumps({'choices': [{'index': 0, 'delta': {'content': 'CRLF_OK'}, 'finish_reason': 'stop'}]})
        split = event.index(',') + 1
        self.respond = lambda _body, _index: ('data: ' + event[:split] + '\r\ndata: ' + event[split:] + '\r\n\r\ndata: [DONE]\r\n\r\n').encode()
        result = self.invoke()
        self.succeeded(result)
        self.assertIn('CRLF_OK', result.stdout)

    def test_custom_posix_shell_accepts_multiline_commands(self):
        self.config['tools'].update(shellExecutable='/bin/sh', shellArgs=[])
        self.respond = lambda _body, index: contracts.tool('bash', {'command': 'value=POSIX_OK\nprintf "%s" "$value"'}) if index == 0 else contracts.answer()
        self.succeeded(self.invoke())
        self.assertEqual(self.tool_results()[-1]['output'], 'POSIX_OK')

if __name__ == "__main__":
    unittest.main(verbosity=2)
