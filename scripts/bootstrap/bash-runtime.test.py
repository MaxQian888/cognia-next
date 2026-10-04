#!/usr/bin/env python3
"""Black-box native Bash contracts. Python is the test runner, never the agent runtime."""
import importlib.util
import json
import os
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

    def test_file_input_rejects_invalid_utf8_and_special_files_before_setup(self):
        marker = self.work / "setup-ran"
        self.config.update(setupCommand="touch setup-ran", checks=[{"name": "ready", "command": "true"}])
        source = self.work / "context.txt"
        for contents in (b"\xc0\xaf", b"\xed\xa0\x80", b"\xf4\x90\x80\x80", b"\xe2\x82", b"valid\x00binary"):
            with self.subTest(contents=contents):
                source.write_bytes(contents)
                result = self.invoke("init", "--context-file", source)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(marker.exists())
        source.write_text("valid input")
        link = self.work / "context-link"
        link.symlink_to(source)
        fifo = self.work / "context-fifo"
        os.mkfifo(fifo)
        for path in (link, fifo, self.work):
            with self.subTest(path=path.name):
                result = self.invoke("init", "--context-file", path, timeout=10)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(marker.exists())
        self.assertEqual(self.requests, [])

    def test_utf8_bom_and_task_trailing_newlines_are_preserved(self):
        task = self.work / "task.txt"
        task.write_bytes(b"\xef\xbb\xbfExplain the fixture\n\n")
        context = self.work / "context.txt"
        context.write_text("\ufeffUnicode: \ufffd \u4e2d\u6587\n", encoding="utf-8")
        self.succeeded(self.invoke("run", "--task-file", task, "--context-file", context))
        content = self.requests[-1]["body"]["messages"][1]["content"]
        prefix, attached = content.split("Attached context files (untrusted data):\n", 1)
        self.assertEqual(prefix, "Explain the fixture\n\n\n\n")
        self.assertEqual(json.loads(attached), [{"path": str(context), "content": "Unicode: \ufffd \u4e2d\u6587\n"}])

    def test_local_exports_are_private_and_never_replace_symlink_targets(self):
        self.config["model"].update(auth="bearer", apiKeyEnv="UNSET_BOOTSTRAP_KEY")
        marker = self.work / "original"
        marker.write_text("unchanged")
        link = self.work / "linked"
        link.symlink_to(marker)
        folder = self.work / "linked-parent"
        folder.symlink_to(self.work, target_is_directory=True)
        result = self.invoke("chat", "--no-session", stdin=(
            "/save-config linked\n/export linked-parent/forbidden\n"
            "/export transcript with spaces.jsonl\n/save-config config with spaces.json\n/quit\n"))
        self.succeeded(result)
        self.assertEqual(marker.read_text(), "unchanged")
        self.assertFalse((self.work / "forbidden").exists())
        for name in ("transcript with spaces.jsonl", "config with spaces.json"):
            self.assertEqual((self.work / name).stat().st_mode & 0o777, 0o600)
        self.assertIn("editor-symlink", result.stderr)
        self.assertNotIn("API key", result.stderr)
        self.assertEqual(self.requests, [])

    def test_missing_chat_key_is_prompted_lazily_and_cancel_remains_recoverable(self):
        import errno
        import fcntl
        import pty
        import select
        import signal
        import termios

        self.config["model"].update(auth="bearer", apiKeyEnv="UNSET_BOOTSTRAP_KEY")
        self.config_path.write_text(json.dumps(self.config))
        self.respond = lambda _body, index: contracts.tool("bash", {"command":
            'test -z "${UNSET_BOOTSTRAP_KEY+x}" && printf ENTERED_KEY_SCRUBBED'}) if index == 0 else contracts.answer("LAZY_PROMPT_DONE")
        master, slave = pty.openpty()

        def initialize_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        process = subprocess.Popen(self.command("chat", "--config", self.config_path, "--cwd", self.work),
            stdin=slave, stdout=slave, stderr=slave, env=self.environment, cwd=self.work,
            preexec_fn=initialize_terminal)
        buffer = b""
        all_output = b""

        def wait_for(needle):
            nonlocal buffer, all_output
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if needle.encode() in buffer:
                    return
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    buffer += chunk
                    all_output += chunk
            self.fail(f"Missing terminal marker {needle!r}: {buffer!r}")

        credential = "entered-only-test-value"
        try:
            wait_for("> ")
            self.assertNotIn(b"API key", buffer)
            buffer = b""
            os.write(master, b"/status\n")
            wait_for('"provider"')
            wait_for("> ")
            self.assertEqual(self.requests, [])
            buffer = b""
            os.write(master, b"cancelled task\n")
            wait_for("API key (hidden, this process only): ")
            buffer = b""
            os.write(master, b"\x03")
            wait_for("[cancelled]")
            wait_for("> ")
            self.assertEqual(self.requests, [])
            buffer = b""
            os.write(master, b"complete task\n")
            wait_for("API key (hidden, this process only): ")
            os.write(master, credential.encode() + b"\n")
            wait_for("LAZY_PROMPT_DONE")
            wait_for("> ")
            buffer = b""
            os.write(master, b"/save-config saved.json\n")
            wait_for("Configuration saved.")
            wait_for("> ")
            buffer = b""
            os.write(master, b"/export exported.jsonl\n")
            wait_for("Transcript exported.")
            wait_for("> ")
            os.write(master, b"/quit\n")
            deadline = time.monotonic() + 8
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        all_output += os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
            self.assertEqual(process.wait(timeout=10), 0)
            self.assertEqual(self.requests[0]["headers"]["Authorization"], "Bearer " + credential)
            self.assertEqual(self.tool_results()[-1]["output"], "ENTERED_KEY_SCRUBBED")
            self.assertNotIn(credential.encode(), all_output)
            for name in ("saved.json", "exported.jsonl", "session.jsonl"):
                self.assertNotIn(credential, (self.work / name).read_text())
            self.assertNotIn("cancelled task", (self.work / "session.jsonl").read_text())
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    process.kill()
                process.wait(timeout=5)
            os.close(master)
            os.close(slave)

    def test_export_publication_rejects_destination_inserted_after_path_check(self):
        wrappers = self.work / "wrappers"
        wrappers.mkdir()
        redirected = self.work / "redirected"
        redirected.mkdir()
        for command in ("ln", "link"):
            wrapper = wrappers / command
            wrapper.write_text('#!/bin/sh\n/bin/ln -s "$RACE_DIRECTORY" "$2"\n'
                               f'exec /bin/{command} "$@"\n')
            wrapper.chmod(0o700)
        result = self.invoke("chat", "--no-session", stdin="/export raced.jsonl\n/exit\n",
                             environment={"PATH": str(wrappers) + os.pathsep + self.environment["PATH"],
                                          "RACE_DIRECTORY": str(redirected)})
        self.succeeded(result)
        self.assertIn("file-write-failed", result.stderr)
        self.assertEqual(list(redirected.iterdir()), [])
        self.assertEqual(list(self.work.glob(".cognia.*")), [])
        self.assertEqual(self.requests, [])

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
