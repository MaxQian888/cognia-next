#!/usr/bin/env python3
"""Exercise standalone agents with real child shells and a local model endpoint."""

import argparse
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
SYNTHETIC_SECRET = "synthetic-secret-do-not-persist-42"


def answer(content="MODEL_OK", reasoning=None):
    message = {"role": "assistant", "content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    return message


def tool(name, arguments, identifier="call_test", reasoning=None):
    message = answer(None, reasoning)
    message["tool_calls"] = [{"id": identifier, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments),
    }}]
    return message


class ModelHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        case = self.server.case
        case.requests.append({"method": "GET", "headers": dict(self.headers), "path": self.path})
        status, response, headers = case.respond_get(self.path)
        payload = response if isinstance(response, bytes) else json.dumps(response).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        case = self.server.case
        case.requests.append({"body": body, "headers": dict(self.headers), "path": self.path})
        try:
            response = case.respond(body, len(case.requests) - 1)
            if isinstance(response, bytes):
                payload = response
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
            elif isinstance(response, tuple):
                status, response = response
                payload = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
            elif body.get("stream"):
                chunks = []
                for key in ("content", "reasoning_content"):
                    if response.get(key):
                        value = response[key]
                        chunks.extend({"choices": [{"index": 0, "delta": {key: part}}]}
                                      for part in (value[:3], value[3:]))
                for index, call in enumerate(response.get("tool_calls", [])):
                    function = call["function"]
                    chunks.extend([
                        {"choices": [{"index": 0, "delta": {"tool_calls": [{
                            "index": index, "id": call["id"], "type": "function", "function": {
                                "name": function["name"], "arguments": function["arguments"][:7],
                            },
                        }]}}]},
                        {"choices": [{"index": 0, "delta": {"tool_calls": [{
                            "index": index, "function": {"arguments": function["arguments"][7:]},
                        }]}}]},
                    ])
                chunks.append({"choices": [{"index": 0, "delta": {}, "finish_reason":
                                           "tool_calls" if response.get("tool_calls") else "stop"}]})
                payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                           + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
            else:
                payload = json.dumps({"choices": [{"index": 0, "message": response,
                    "finish_reason": "tool_calls" if response.get("tool_calls") else "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            for offset in range(0, len(payload), 11):
                self.wfile.write(payload[offset:offset + 11])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:
            case.server_errors.append(error)


class StandaloneContract:
    runtime = ""
    executable = ""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cognia-standalone-")
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name).resolve()
        self.requests = []
        self.server_errors = []
        self.respond = lambda _body, _index: answer()
        self.respond_get = lambda _path: (200, {"data": [{"id": "z-model"}, {"id": "a-model"}, {"id": "z-model"}]}, {})
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        self.server.daemon_threads = True
        self.server.case = self
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = {
            "version": 1, "task": "Synthetic acceptance task",
            "model": {"baseUrl": f"http://127.0.0.1:{self.server.server_port}/v1",
                      "model": "synthetic-model", "auth": "none", "requestTimeoutSecs": 10},
            "context": {"autoCompact": False}, "tools": {"profile": "dsh"},
            "limits": {"maxSteps": 24, "totalTimeoutSecs": 30, "commandTimeoutSecs": 5,
                       "maxContextBytes": 128000, "maxOutputBytes": 16000},
        }
        self.config_path = self.work / "config.json"
        inherited_names = {"PATH", "HOME", "USER", "USERNAME", "TMP", "TMPDIR", "TEMP", "LANG", "LC_ALL",
                           "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES",
                           "PROGRAMFILES(X86)", "PROGRAMDATA", "LOCALAPPDATA", "APPDATA", "USERPROFILE"}
        self.environment = {key: value for key, value in os.environ.items() if key.upper() in inherited_names}
        self.environment.update({"NO_COLOR": "1", "TERM": "dumb"})

    def tearDown(self):
        self.assertEqual(self.server_errors, [])

    def command(self, *arguments):
        if self.runtime == "bash":
            return [self.executable, str(SCRIPT_DIR / "cognia-bootstrap.sh"), *map(str, arguments)]
        return [self.executable, "-NoLogo", "-NoProfile", "-File",
                str(SCRIPT_DIR / "cognia-bootstrap.ps1"), *map(str, arguments)]

    def invoke(self, mode="run", *arguments, stdin=None, environment=None, timeout=45):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        process = subprocess.Popen(
            self.command(mode, "--config", self.config_path, "--cwd", self.work, *arguments),
            cwd=self.work, env={**self.environment, **(environment or {})},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", start_new_session=os.name != "nt",
        )
        try:
            output, errors = process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, check=False)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
            self.fail(f"{self.runtime} {mode} exceeded {timeout}s")
        return subprocess.CompletedProcess(process.args, process.returncode, output, errors)

    def succeeded(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)

    def shell(self, bash, powershell):
        return powershell if self.runtime == "powershell" else bash

    def tool_results(self):
        return [json.loads(message["content"]) for message in self.requests[-1]["body"]["messages"]
                if message["role"] == "tool"]

    def test_preset_catalog_is_embedded_and_matches_source(self):
        extension = "sh" if self.runtime == "bash" else "ps1"
        copied = self.work / f"copied.{extension}"
        shutil.copyfile(SCRIPT_DIR / f"cognia-bootstrap.{extension}", copied)
        prefix = [self.executable] if self.runtime == "bash" else [self.executable, "-NoProfile", "-File"]
        result = subprocess.run([*prefix, str(copied), "presets", "--json"],
                                capture_output=True, text=True, cwd=self.work,
                                env=self.environment, timeout=20)
        self.succeeded(result)
        self.assertEqual(json.loads(result.stdout), json.loads((SCRIPT_DIR / "presets.json").read_text()))
        self.assertEqual(self.requests, [])

    def test_preset_provider_resets_old_transport_and_keeps_overrides(self):
        self.config["model"].update({"headers": {"X-Old": "old"},
                                     "headersEnv": {"X-Old-Key": "OLD_KEY"},
                                     "auth": "header", "apiKeyHeader": "Old-Auth",
                                     "endpointPath": "/old", "extraBody": {"old_option": True}})
        destination = self.work / "provider.json"
        result = self.invoke("configure", "--provider", "deepseek", "--preset", "coding",
                             "--non-interactive", "--output", destination,
                             "--model", "explicit-model", "--set", "model.maxTokens=1234")
        self.succeeded(result)
        value = json.loads(destination.read_text(encoding="utf-8-sig"))
        self.assertEqual(value["model"]["model"], "explicit-model")
        self.assertEqual(value["model"]["apiKeyEnv"], "DEEPSEEK_API_KEY")
        self.assertEqual(value["model"]["auth"], "bearer")
        self.assertEqual(value["model"]["headers"], {})
        self.assertEqual(value["model"]["headersEnv"], {})
        self.assertEqual(value["model"]["extraBody"], {})
        self.assertIsNone(value["model"].get("endpointPath"))
        self.assertIsNone(value["model"].get("apiKeyHeader"))
        self.assertEqual(value["model"]["maxTokens"], 1234)
        self.assertTrue(value["tools"]["shell"])
        self.assertEqual(value["limits"]["maxSteps"], 48)

    def test_preset_configure_without_config_accepts_explicit_stream_boolean(self):
        for stream in ("true", "false"):
            with self.subTest(stream=stream):
                destination = self.work / f"stream-{stream}.json"
                result = subprocess.run(self.command("configure", "--provider", "deepseek", "--preset", "coding",
                    "--stream", stream, "--non-interactive", "--output", destination),
                    cwd=self.work, env=self.environment, capture_output=True, text=True, timeout=20)
                self.succeeded(result)
                value = json.loads(destination.read_text(encoding="utf-8-sig"))
                self.assertEqual(value["model"]["stream"], stream == "true")
                self.assertEqual(value["model"]["model"], "deepseek-flash")
                self.assertEqual(value["model"]["apiKeyEnv"], "DEEPSEEK_API_KEY")

    def test_preset_custom_files_merge_in_order_before_cli_and_set(self):
        first, second = self.work / "first.json", self.work / "second.json"
        first.write_text(json.dumps({"model": {"temperature": 0.2, "maxTokens": 600},
                                     "reuse": {"inputs": ["old.txt"]}, "systemPrompt": "first"}))
        second.write_text(json.dumps({"model": {"maxTokens": 700},
                                      "reuse": {"inputs": ["new.txt"]}, "systemPrompt": None}))
        destination = self.work / "custom.json"
        result = self.invoke("configure", "--preset", "chat", "--preset-file", first,
                             "--preset-file", second, "--max-tokens", "800",
                             "--task", "CLI task", "--set", 'task="Final task"',
                             "--set", "model.maxTokens=900", "--non-interactive", "--output", destination,
                             environment={"COGNIA_BOOTSTRAP_MODEL": "environment-model"})
        self.succeeded(result)
        value = json.loads(destination.read_text(encoding="utf-8-sig"))
        self.assertEqual(value["task"], "Final task")
        self.assertEqual(value["model"]["maxTokens"], 900)
        self.assertEqual(value["model"]["temperature"], 0.2)
        self.assertEqual(value["model"]["model"], "environment-model")
        self.assertEqual(value["reuse"]["inputs"], ["new.txt"])
        self.assertIsNone(value["systemPrompt"])
        self.assertFalse(value["tools"]["shell"])
        self.assertFalse(value["tools"]["editor"])

    def test_preset_recipes_expand_without_running_setup(self):
        catalog = json.loads((SCRIPT_DIR / "presets.json").read_text())
        for recipe in catalog["recipes"]:
            with self.subTest(recipe=recipe["id"]):
                destination = self.work / f'{recipe["id"]}.json'
                result = self.invoke("configure", "--recipe", recipe["id"],
                                     "--non-interactive", "--output", destination)
                self.succeeded(result)
                value = json.loads(destination.read_text(encoding="utf-8-sig"))
                expected = {**recipe["config"], **(recipe.get("powershell", {}) if self.runtime == "powershell" else {})}
                for field in ("setupCommand", "checks", "reuse"):
                    self.assertEqual(value[field], expected[field])
        self.assertEqual(self.requests, [])
        self.assertFalse((self.work / "node_modules").exists())
        self.assertFalse((self.work / ".venv").exists())

    def test_preset_invalid_ids_and_patches_fail_without_writing(self):
        destination, patch = self.work / "invalid.json", self.work / "patch.json"
        for arguments in [("--provider", "missing"), ("--preset", "missing"), ("--recipe", "missing")]:
            with self.subTest(arguments=arguments):
                result = self.invoke("configure", *arguments, "--non-interactive", "--output", destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists())
        for value in ([], {"model": {"typo": True}}, {"unknown": 1}):
            with self.subTest(patch=value):
                patch.write_text(json.dumps(value))
                result = self.invoke("configure", "--preset-file", patch,
                                     "--non-interactive", "--output", destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists())

    def test_doctor_is_offline_and_reports_missing_credentials(self):
        self.config["model"].update({"auth": "bearer", "apiKeyEnv": "DOCTOR_TEST_KEY"})
        self.config["setupCommand"] = self.shell("touch unexpected", "Set-Content unexpected x")
        result = self.invoke("doctor", "--json")
        self.assertNotEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertFalse(report["ok"])
        self.assertIn("DOCTOR_TEST_KEY", result.stdout)
        ready = self.invoke("doctor", "--json", environment={"DOCTOR_TEST_KEY": SYNTHETIC_SECRET})
        self.succeeded(ready)
        self.assertTrue(json.loads(ready.stdout)["ok"])
        self.assertNotIn(SYNTHETIC_SECRET, ready.stdout + ready.stderr)
        self.assertEqual(self.requests, [])
        self.assertFalse((self.work / "unexpected").exists())

    def test_doctor_reports_local_model_placeholder(self):
        result = self.invoke("doctor", "--provider", "ollama", "--json")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)["ok"])
        self.assertIn("model", result.stdout.lower())
        self.assertEqual(self.requests, [])

    def test_models_discovery_uses_configured_auth_and_custom_path(self):
        self.config["model"].update({"auth": "bearer", "apiKeyEnv": "MODEL_LIST_KEY",
                                     "headersEnv": {"X-Reference": "MODEL_HEADER_KEY"}})
        result = self.invoke("models", "--json", "--models-path", "/catalog/models",
                             environment={"MODEL_LIST_KEY": SYNTHETIC_SECRET, "MODEL_HEADER_KEY": "header-value"})
        self.succeeded(result)
        self.assertEqual(json.loads(result.stdout), ["a-model", "z-model"])
        self.assertEqual(self.requests[0]["path"], "/v1/catalog/models")
        headers = {name.lower(): value for name, value in self.requests[0]["headers"].items()}
        self.assertEqual(headers["authorization"], "Bearer " + SYNTHETIC_SECRET)
        self.assertEqual(headers["x-reference"], "header-value")
        self.assertNotIn(SYNTHETIC_SECRET, result.stdout + result.stderr)

    def test_models_discovery_rejects_unsafe_paths_before_http(self):
        for path in ("//other.example/models", "/../models", "/models?secret=yes", "/models#fragment", "/bad\\models", "/%2e%2e/models"):
            with self.subTest(path=path):
                result = self.invoke("models", "--models-path", path)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])

    def test_models_discovery_rejects_redirect_invalid_and_private_responses(self):
        for status, response, headers in [
            (302, {}, {"Location": self.config["model"]["baseUrl"] + "/redirected"}),
            (401, {"error": "authentication failed"}, {}),
            (200, {"data": [{"id": ""}]}, {}),
            (200, {"data": [{"id": "   "}]}, {}),
            (200, {"data": [{"id": "x" * 257}]}, {}),
            (200, {"data": "not-an-array"}, {}),
            (200, {"data": [{"id": "contact-person@example.com"}]}, {}),
        ]:
            with self.subTest(status=status, response=response):
                self.respond_get = lambda _path: (status, response, headers)
                before = len(self.requests)
                result = self.invoke("models", "--json")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.requests), before + 1)
                self.assertNotIn("contact-person@example.com", result.stdout + result.stderr)

    def test_models_discovery_bounds_response_size(self):
        self.config["limits"]["maxResponseBytes"] = 4096
        self.respond_get = lambda _path: (200, {"data": [{"id": "x" * 8000}]}, {})
        result = self.invoke("models", "--json")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("x" * 4096, result.stdout + result.stderr)

    def test_chat_model_commands_change_future_requests_only(self):
        result = self.invoke("chat", "--no-session", stdin="/status\n/model next-model\n/models\nhello\n/exit\n")
        self.succeeded(result)
        posts = [request for request in self.requests if request.get("method") != "GET"]
        gets = [request for request in self.requests if request.get("method") == "GET"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(len(gets), 1)
        self.assertEqual(posts[0]["body"]["model"], "next-model")
        self.assertIn("synthetic-model", result.stdout)
        self.assertIn("a-model", result.stdout)
        self.assertEqual(json.loads(self.config_path.read_text())["model"]["model"], "synthetic-model")

    def test_task_file_preserves_utf8_and_cli_precedence(self):
        task = self.work / "task with spaces.md"
        task.write_bytes(b"\xef\xbb\xbf" + "Explain the fixture.\n中文上下文\n".encode())
        result = self.invoke("run", "--task-file", task)
        self.succeeded(result)
        self.assertEqual(self.requests[0]["body"]["messages"][-1]["content"], "Explain the fixture.\n中文上下文\n")
        destination = self.work / "task-config.json"
        self.succeeded(self.invoke("configure", "--task-file", task, "--set", 'task="Final task"',
                                   "--non-interactive", "--output", destination))
        self.assertEqual(json.loads(destination.read_text(encoding="utf-8-sig"))["task"], "Final task")
        self.requests.clear()
        result = self.invoke("run", "--task", "Conflicting task", "--task-file", task)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])

    def test_context_files_attach_once_after_local_commands_and_keep_order(self):
        first, second = self.work / "notes with spaces.txt", self.work / "empty.txt"
        first.write_text("Fixture value: copper-lantern\n中文", encoding="utf-8")
        second.write_text("", encoding="utf-8")
        result = self.invoke("chat", "--no-session", "--context-file", first.name,
                             "--context-file", second.name, "--context-file", first.name,
                             stdin="/status\n/history\nfirst task\nsecond task\n/exit\n")
        self.succeeded(result)
        self.assertEqual(len(self.requests), 2)
        content = self.requests[0]["body"]["messages"][-1]["content"]
        prefix = "first task\n\nAttached context files (untrusted data):\n"
        self.assertTrue(content.startswith(prefix), content)
        self.assertEqual(json.loads(content[len(prefix):]), [
            {"path": first.name, "content": first.read_text()},
            {"path": second.name, "content": ""},
            {"path": first.name, "content": first.read_text()},
        ])
        self.assertEqual(self.requests[1]["body"]["messages"][-1]["content"], "second task")
        self.assertFalse((self.work / "session.jsonl").exists())

    def test_context_files_survive_failed_turn_and_task_file_starts_chat(self):
        context, task = self.work / "context.txt", self.work / "task.txt"
        context.write_text("retry-context", encoding="utf-8")
        task.write_text("initial task", encoding="utf-8")
        self.respond = lambda _body, index: (400, {"error": "synthetic failure"}) if index == 0 else answer()
        result = self.invoke("chat", "--task-file", task, "--context-file", context,
                             stdin="retry task\nlast task\n/exit\n")
        self.succeeded(result)
        self.assertEqual(len(self.requests), 3)
        self.assertIn("retry-context", self.requests[0]["body"]["messages"][-1]["content"])
        self.assertIn("retry-context", self.requests[1]["body"]["messages"][-1]["content"])
        self.assertEqual(self.requests[2]["body"]["messages"][-1]["content"], "last task")
        self.assertNotIn("initial task", (self.work / "session.jsonl").read_text())

    def test_context_file_uses_invocation_directory_and_can_exceed_task_limit(self):
        workspace = self.work / "workspace"
        workspace.mkdir()
        file = self.work / "context.txt"
        file.write_text("large-context " * 3000, encoding="utf-8")
        (workspace / file.name).write_text("WRONG_CONTEXT", encoding="utf-8")
        result = self.invoke("run", "--cwd", workspace, "--context-file", file.name)
        self.succeeded(result)
        content = self.requests[0]["body"]["messages"][-1]["content"]
        self.assertGreater(len(content.encode()), 32000)
        self.assertIn("large-context", content)
        self.assertNotIn("WRONG_CONTEXT", content)

    def test_file_inputs_reject_missing_binary_invalid_utf8_and_oversize(self):
        file = self.work / "input.txt"
        self.config["tools"]["maxFileBytes"] = 1024
        for payload in (b"valid\x00binary", b"invalid\xffutf8", b"x" * 32001):
            for flag in ("--task-file", "--context-file"):
                with self.subTest(payload_size=len(payload), flag=flag):
                    file.write_bytes(payload)
                    result = self.invoke("run", flag, file)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.requests, [])
        file.unlink()
        for flag in ("--task-file", "--context-file"):
            self.assertNotEqual(self.invoke("run", flag, file).returncode, 0)
        file.write_text(" \n", encoding="utf-8")
        self.assertNotEqual(self.invoke("run", "--task-file", file).returncode, 0)
        self.assertEqual(self.requests, [])

    def test_context_budget_and_privacy_fail_before_outbound_or_setup(self):
        file = self.work / "context.txt"
        self.config["limits"]["maxContextBytes"] = 4096
        file.write_text("x" * 2100, encoding="utf-8")
        result = self.invoke("run", "--context-file", file, "--context-file", file)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])
        file.write_text(SYNTHETIC_SECRET, encoding="utf-8")
        result = self.invoke("run", "--context-file", file,
                             environment={"ATTACHED_PRIVATE_KEY": SYNTHETIC_SECRET})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(SYNTHETIC_SECRET, result.stdout + result.stderr)
        self.assertEqual(self.requests, [])
        self.config["setupCommand"] = self.shell("touch must-not-run", "Set-Content must-not-run x")
        self.config["checks"] = [{"name": "ready", "command": self.shell("true", "$null = 1")}]
        result = self.invoke("init", "--context-file", self.work / "missing-context.txt")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.work / "must-not-run").exists())

    @unittest.skipIf(os.name == "nt", "POSIX FIFO and symlink input boundary")
    def test_file_inputs_reject_fifo_and_symlinks_without_blocking(self):
        regular, link, fifo = self.work / "normal.txt", self.work / "alias.txt", self.work / "input.fifo"
        regular.write_text("ordinary input", encoding="utf-8")
        link.symlink_to(regular)
        os.mkfifo(fifo)
        for path in (link, fifo):
            for flag in ("--task-file", "--context-file"):
                with self.subTest(path=path.name, flag=flag):
                    result = self.invoke("run", flag, path, timeout=8)
                    self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])

    def test_local_chat_exports_and_saves_config_without_a_credential(self):
        self.config["model"].update({"auth": "bearer", "apiKeyEnv": "OFFLINE_MISSING_KEY"})
        result = self.invoke("chat", "--no-session",
            stdin="/model saved-model\n/history\n/export offline session.jsonl\n/save-config saved config.json\n/exit\n")
        self.succeeded(result)
        self.assertEqual(self.requests, [])
        exported, saved = self.work / "offline session.jsonl", self.work / "saved config.json"
        self.assertTrue(exported.exists())
        self.assertEqual(json.loads(saved.read_text(encoding="utf-8-sig"))["model"]["model"], "saved-model")
        self.assertEqual(json.loads(self.config_path.read_text())["model"]["model"], "synthetic-model")
        self.assertFalse((self.work / "session.jsonl").exists())
        if os.name != "nt":
            self.assertEqual(exported.stat().st_mode & 0o777, 0o600)
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)

    def test_exported_session_resumes_and_failed_turn_is_excluded(self):
        self.respond = lambda _body, index: (400, {"error": "synthetic failure"}) if index == 1 else answer()
        result = self.invoke("chat", "--no-session",
            stdin="remember copper-lantern\nfailed task\n/export copied session.jsonl\nnew task\n/exit\n")
        self.succeeded(result)
        exported = self.work / "copied session.jsonl"
        text = exported.read_text(encoding="utf-8-sig")
        self.assertIn("remember copper-lantern", text)
        self.assertNotIn("failed task", text)
        self.assertNotIn("new task", text)
        self.requests.clear()
        self.respond = lambda _body, _index: answer()
        self.succeeded(self.invoke("run", "--session", exported, "--task", "resume"))
        self.assertIn("remember copper-lantern", json.dumps(self.requests[0]["body"]["messages"]))
        self.assertNotIn("failed task", json.dumps(self.requests[0]["body"]["messages"]))

    def test_history_preview_is_local_bounded_and_omits_session_metadata(self):
        self.respond = lambda _body, _index: answer("history-preview-marker-" * 30)
        self.succeeded(self.invoke("chat", stdin="first task\nsecond task\n/exit\n"))
        self.requests.clear()
        self.config["model"].update({"auth": "bearer", "apiKeyEnv": "OFFLINE_MISSING_KEY"})
        result = self.invoke("chat", stdin="/history 1\n/exit\n")
        self.succeeded(result)
        preview = json.loads(result.stdout[result.stdout.index("["):result.stdout.rindex("]") + 1])
        self.assertEqual(len(preview), 1)
        self.assertEqual(preview[0]["role"], "assistant")
        self.assertNotIn("_cogniaSession", result.stdout)
        self.assertEqual(self.requests, [])
        before = (self.work / "session.jsonl").read_bytes()
        result = self.invoke("chat", stdin="/history 0\n/history 101\n/history nope\n/exit\n")
        self.succeeded(result)
        self.assertTrue(result.stderr.strip())
        self.assertEqual((self.work / "session.jsonl").read_bytes(), before)
        self.assertEqual(self.requests, [])
        self.config["limits"]["maxOutputBytes"] = 256
        result = self.invoke("chat", stdin="/history 1\n/exit\n")
        self.succeeded(result)
        self.assertNotIn("history-preview-marker-", result.stdout)
        self.assertTrue(result.stderr.strip())
        self.assertEqual(self.requests, [])

    def test_local_exports_gate_private_payloads_before_creating_files(self):
        self.config["systemPrompt"] = SYNTHETIC_SECRET
        result = self.invoke("chat", "--no-session", environment={"LOCAL_PRIVATE_KEY": SYNTHETIC_SECRET},
                             stdin="/export private.jsonl\n/save-config private.json\n/exit\n")
        self.succeeded(result)
        self.assertFalse((self.work / "private.jsonl").exists())
        self.assertFalse((self.work / "private.json").exists())
        self.assertNotIn(SYNTHETIC_SECRET, result.stdout + result.stderr)
        self.assertEqual(self.requests, [])

    def test_local_exports_refuse_overwrite_and_workspace_escape(self):
        existing = self.work / "existing.txt"
        existing.write_text("KEEP", encoding="utf-8")
        escaped = self.work.parent / (self.work.name + "-escaped.json")
        self.addCleanup(lambda: escaped.unlink(missing_ok=True))
        commands = (f"/export existing.txt\n/save-config existing.txt\n/export ../{escaped.name}\n"
                    f"/save-config ../{escaped.name}\n/export missing/out.jsonl\n/exit\n")
        self.succeeded(self.invoke("chat", "--no-session", stdin=commands))
        self.assertEqual(existing.read_text(), "KEEP")
        self.assertFalse(escaped.exists())
        self.assertFalse((self.work / "missing").exists())
        self.assertEqual(self.requests, [])

    def test_configure_custom_provider_without_embedded_secret(self):
        destination = self.work / "configured.json"
        result = subprocess.run(self.command("configure", "--non-interactive", "--output", destination,
            "--model", "custom-model", "--base-url", self.config["model"]["baseUrl"],
            "--api-key-env", "TEST_PRIVATE_KEY"), capture_output=True, text=True,
            env={**self.environment, "TEST_PRIVATE_KEY": SYNTHETIC_SECRET}, timeout=20)
        self.succeeded(result)
        value = json.loads(destination.read_text(encoding="utf-8-sig"))
        self.assertEqual(value["model"]["model"], "custom-model")
        self.assertEqual(value["model"]["apiKeyEnv"], "TEST_PRIVATE_KEY")
        self.assertNotIn(SYNTHETIC_SECRET, destination.read_text())
        if os.name != "nt":
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        refused = subprocess.run(self.command("configure", "--non-interactive", "--output", destination),
                                 capture_output=True, text=True, env=self.environment, timeout=20)
        self.assertNotEqual(refused.returncode, 0)

    def test_stdin_overrides_headers_and_custom_provider_parameters(self):
        self.config["model"].update({"headers": {"X-Label": "ordinary"},
                                     "headersEnv": {"X-Reference": "TEST_HEADER_KEY"},
                                     "endpointPath": "custom/completions"})
        result = self.invoke("run", "--task", "-", "--model", "cli-model",
            "--set", 'model.model="set-model"', "--set", "model.temperature=0.2",
            "--set", "model.topP=0.7", "--set", "model.seed=17",
            "--set", 'model.reasoningEffort="high"', "--set", 'model.thinking={"type":"enabled"}',
            "--set", 'model.extraBody.response_format={"type":"text"}',
            "--set", 'systemPrompt="TEST_PERSONA"', stdin="stdin task",
            environment={"MODEL_NAME": "legacy", "COGNIA_BOOTSTRAP_MODEL": "environment-model",
                         "TEST_HEADER_KEY": SYNTHETIC_SECRET})
        self.succeeded(result)
        request = self.requests[-1]
        body = request["body"]
        self.assertEqual(body["model"], "set-model")
        self.assertEqual(body["temperature"], 0.2)
        self.assertEqual(body["top_p"], 0.7)
        self.assertEqual(body["seed"], 17)
        self.assertEqual(body["reasoning_effort"], "high")
        self.assertEqual(body["thinking"], {"type": "enabled"})
        self.assertEqual(body["response_format"], {"type": "text"})
        self.assertIn("stdin task", json.dumps(body["messages"]))
        self.assertIn("TEST_PERSONA", body["messages"][0]["content"])
        headers = {key.lower(): value for key, value in request["headers"].items()}
        self.assertEqual(headers["x-reference"], SYNTHETIC_SECRET)
        self.assertNotIn("authorization", headers)
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(body))
        self.assertEqual(request["path"], "/v1/custom/completions")
        self.succeeded(self.invoke(environment={"MODEL_NAME": "legacy-model",
            "COGNIA_BOOTSTRAP_MODEL": "environment-model", "TEST_HEADER_KEY": SYNTHETIC_SECRET}))
        self.assertEqual(self.requests[-1]["body"]["model"], "environment-model")

    def test_header_auth_and_credentials_absent_from_child_and_history(self):
        self.config["model"].update({"auth": "header", "apiKeyHeader": "X-Test-Key",
                                     "apiKeyEnv": "TEST_PRIVATE_KEY"})
        command = self.shell('test -z "${TEST_PRIVATE_KEY+x}" && printf KEY_ABSENT',
                             'if (-not $env:TEST_PRIVATE_KEY) { Write-Output "KEY_ABSENT" }')
        self.respond = lambda body, _index: (answer() if body["messages"][-1]["role"] == "tool"
                                             else tool("bash", {"command": command}))
        result = self.invoke("chat", stdin="check environment\n/exit\n",
                             environment={"TEST_PRIVATE_KEY": SYNTHETIC_SECRET})
        self.succeeded(result)
        self.assertIn("KEY_ABSENT", self.tool_results()[-1]["output"])
        self.assertEqual({k.lower(): v for k, v in self.requests[0]["headers"].items()}["x-test-key"],
                         SYNTHETIC_SECRET)
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps([request["body"] for request in self.requests]))
        self.assertNotIn(SYNTHETIC_SECRET, (self.work / "session.jsonl").read_text())

    def test_ambient_cookie_and_authorization_are_scrubbed_and_gated(self):
        names = ['SESSION_COOKIE', 'CUSTOM_AUTHORIZATION', 'CUSTOM_APIKEY', 'SERVICE_PASSWD']
        environment = {name: 'synthetic-ambient-value-' + str(index)
                       for index, name in enumerate(names)}
        command = self.shell(
            'printf "%s|%s|%s|%s" "${SESSION_COOKIE-ABSENT}" "${CUSTOM_AUTHORIZATION-ABSENT}" '
            '"${CUSTOM_APIKEY-ABSENT}" "${SERVICE_PASSWD-ABSENT}"',
            '; '.join('if (-not $env:' + name + ') { Write-Output "ABSENT" } else { Write-Output $env:' + name + ' }'
                      for name in names))
        self.respond = lambda _body, index: tool('bash', {'command': command}) if index == 0 else answer()
        self.succeeded(self.invoke(environment=environment))
        self.assertEqual(self.tool_results()[-1]['output'].count('ABSENT'), len(names))
        for value in environment.values():
            self.requests.clear()
            self.config['task'] = 'Repeat ' + value
            self.assertNotEqual(self.invoke(environment=environment).returncode, 0)
            self.assertEqual(self.requests, [])

    def test_numeric_and_named_credentials_in_metadata_are_gated(self):
        for metadata in ({'phone': 13812345678}, {'DEPLOY_KEY': 'synthetic-short-value'},
                         {json.dumps({'nested': r'\n0000002'}): 'ordinary'}):
            with self.subTest(metadata=metadata):
                self.config['model']['extraBody'] = {'metadata': metadata}
                self.assertNotEqual(self.invoke().returncode, 0)
                self.assertEqual(self.requests, [])

    def test_json_control_escapes_do_not_turn_offsets_into_passports(self):
        command = self.shell("printf '%s\\n' '0000000    1   6' '0000002'",
                             "Write-Output ('0000000    1   6' + [char]10 + '0000002')")
        self.respond = lambda _body, index: tool("bash", {"command": command}) if index == 0 else answer()
        result = self.invoke("run", "--session", self.work / "offsets.jsonl")
        self.succeeded(result)
        self.assertIn("0000000    1   6\n0000002", self.tool_results()[-1]["output"].replace("\r\n", "\n"))
        self.assertIn("0000002", (self.work / "offsets.jsonl").read_text())
        requests_before = len(self.requests)
        result = self.invoke("chat", "--session", self.work / "offsets.jsonl",
                             stdin="/export offsets-export.jsonl\n/exit\n")
        self.succeeded(result)
        self.assertIn("0000002", (self.work / "offsets-export.jsonl").read_text())
        self.assertEqual(len(self.requests), requests_before)

    def test_json_escape_handling_preserves_raw_and_nested_privacy_detection(self):
        for task in ("N0000002", "\\n0000002", json.dumps({"passport": "N0000002"}),
                     json.dumps({"passport": "\\n0000002"}),
                     '{"passport":"\\u004e0000002"}',
                     json.dumps({"phone": 13812345678})):
            with self.subTest(task=task):
                self.requests.clear()
                self.config["task"] = task
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.requests, [])

    def test_readiness_output_recursively_checks_json_strings(self):
        encoded = json.dumps({"nested": r"\n0000002"})
        command = self.shell("printf '%s' '" + encoded + "'", "Write-Output '" + encoded + "'")
        self.config["setupCommand"] = self.shell("true", "$null = 1")
        self.config["checks"] = [{"name": "synthetic-check", "command": command}]
        result = self.invoke("init")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("0000002", result.stdout + result.stderr)
        self.assertEqual(self.requests, [])

    def test_zero_hex_offsets_are_allowed_but_cards_and_exact_secrets_stay_blocked(self):
        command = self.shell("printf '0000000000000000  31 36\\n'", "Write-Output '0000000000000000  31 36'")
        self.respond = lambda _body, index: tool("bash", {"command": command}) if index == 0 else answer()
        self.succeeded(self.invoke())
        self.assertIn("0000000000000000", self.tool_results()[-1]["output"])
        self.requests.clear()
        self.config["task"] = "4111111111111111"
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(self.requests, [])
        self.config["task"] = "0000000000000000"
        self.assertNotEqual(self.invoke(environment={"SYNTHETIC_PRIVATE_KEY": "0000000000000000"}).returncode, 0)
        self.assertEqual(self.requests, [])

    def test_persistent_shell_functions_environment_and_clear(self):
        establish = self.shell('export TEST_STATE=kept; test_function(){ printf FUNCTION_OK; }',
                               '$env:TEST_STATE="kept"; function global:Test-Function { "FUNCTION_OK" }')
        verify = self.shell('printf "%s|" "$TEST_STATE"; test_function',
                            'Write-Output "$env:TEST_STATE|"; Test-Function')
        def respond(body, _index):
            if body["messages"][-1]["role"] == "tool":
                return answer("TURN_DONE")
            task = body["messages"][-1]["content"]
            return tool("bash", {"command": establish if task == "establish" else verify})
        self.respond = respond
        result = self.invoke("chat", stdin="establish\nverify\n/exit\n")
        self.succeeded(result)
        self.assertIn("kept|", self.tool_results()[-1]["output"])
        self.assertIn("FUNCTION_OK", self.tool_results()[-1]["output"])
        self.assertEqual(result.stdout.count("TURN_DONE"), 2)
        self.assertNotIn("_cogniaSession", json.dumps(self.requests[-1]["body"]))

    def test_session_resume_clear_and_disable(self):
        self.succeeded(self.invoke("chat", stdin="stored first turn\n/exit\n"))
        session = self.work / "session.jsonl"
        self.assertTrue(session.exists())
        self.succeeded(self.invoke("chat", stdin="resumed turn\n/exit\n"))
        self.assertIn("stored first turn", json.dumps(self.requests[-1]["body"]))
        self.succeeded(self.invoke("chat", stdin="/clear\nfresh turn\n/quit\n"))
        self.assertNotIn("stored first turn", json.dumps(self.requests[-1]["body"]))
        self.assertNotIn("stored first turn", session.read_text())
        session.unlink()
        self.succeeded(self.invoke("chat", "--no-session", stdin="unpersisted\n/exit\n"))
        self.assertFalse(session.exists())

    def test_dsh_editor_operations_and_errors(self):
        target = self.work / "sample.txt"
        visible = self.work / "directory" / "nested" / "visible.txt"
        visible.parent.mkdir(parents=True)
        visible.write_text("visible")
        for name in (".hidden", "node_modules", "__pycache__"):
            hidden = self.work / "directory" / name
            hidden.mkdir()
            (hidden / "excluded.txt").write_text("excluded")
        operations = [
            {"command": "create", "path": str(target), "file_text": "alpha\nbeta\nbeta\nomega\n"},
            {"command": "view", "path": str(target), "view_range": [2, -1]},
            {"command": "insert", "path": str(target), "insert_line": 0, "new_str": "prefix"},
            {"command": "str_replace", "path": str(target), "old_str": "beta", "new_str": "bad"},
            {"command": "str_replace", "path": str(target), "old_str": "alpha", "new_str": "ALPHA"},
            {"command": "str_replace", "path": str(target), "old_str": "omega\n"},
            {"command": "view", "path": str(self.work / "directory")},
            {"command": "create", "path": str(target), "file_text": "overwrite"},
        ]
        self.respond = lambda _body, index: (tool("str_replace_editor", operations[index], f"edit_{index}")
                                             if index < len(operations) else answer())
        self.succeeded(self.invoke())
        results = self.tool_results()
        self.assertEqual(len(results), len(operations))
        self.assertNotIn("alpha", results[1]["output"])
        self.assertIn("omega", results[1]["output"])
        self.assertTrue(target.read_text().startswith("prefix\nALPHA\n"))
        self.assertNotIn("bad", target.read_text())
        self.assertNotIn("omega", target.read_text())
        self.assertIn("visible.txt", results[6]["output"])
        for excluded in (".hidden", "node_modules", "__pycache__", "excluded.txt"):
            self.assertNotIn(excluded, results[6]["output"])
        self.assertNotIn("overwrite", target.read_text())

    def test_tool_grants_exclude_disabled_tools(self):
        self.config["tools"].update({"shell": False, "editor": True})
        self.succeeded(self.invoke())
        names = [entry["function"]["name"] for entry in self.requests[-1]["body"]["tools"]]
        self.assertEqual(names, ["str_replace_editor"])

    def test_native_editor_relative_paths_and_insert_semantics(self):
        self.config["tools"]["profile"] = "native"
        operations = [
            {"action": "create", "path": "native.txt", "content": "first\nlast\n"},
            {"action": "insert", "path": "native.txt", "line": 2, "newText": "middle\n"},
            {"action": "replace", "path": "native.txt", "oldText": "last", "newText": "final"},
            {"action": "view", "path": "native.txt", "startLine": 2, "endLine": 3},
        ]
        self.respond = lambda _body, index: (tool("editor", operations[index], f"native_{index}")
                                             if index < len(operations) else answer())
        self.succeeded(self.invoke())
        self.assertEqual((self.work / "native.txt").read_text(), "first\nmiddle\nfinal\n")
        self.assertIn("middle", self.tool_results()[-1]["output"])
        self.assertNotIn("first", self.tool_results()[-1]["output"])

    @unittest.skipIf(os.name == "nt", "Creating symlinks requires Windows privilege or Developer Mode")
    def test_editor_rejects_parent_traversal_and_symlink_escape(self):
        self.config["tools"]["profile"] = "native"
        traversed = self.work.parent / (self.work.name + "-escape.txt")
        self.addCleanup(traversed.unlink, missing_ok=True)
        newline_escape = self.work.parent / (self.work.name + '-newline-escape.txt')
        self.addCleanup(newline_escape.unlink, missing_ok=True)
        (self.work / 'line\n').mkdir()
        with tempfile.TemporaryDirectory(prefix="cognia-outside-") as outside:
            outside_file = Path(outside) / "original.txt"
            outside_file.write_text("original")
            (self.work / "escape").symlink_to(outside, target_is_directory=True)
            operations = [
                {"action": "replace", "path": "escape/original.txt", "oldText": "original", "newText": "changed"},
                {"action": "create", "path": "../" + traversed.name, "content": "changed"},
                {"action": "create", "path": "line\n/../../" + newline_escape.name, "content": "changed"},
            ]
            self.respond = lambda _body, index: (tool("editor", operations[index], f"escape_{index}")
                                                 if index < len(operations) else answer())
            self.succeeded(self.invoke())
            self.assertEqual(outside_file.read_text(), "original")
            self.assertFalse(traversed.exists())
            self.assertFalse(newline_escape.exists())
            self.assertEqual(len(self.tool_results()), 3)

    def test_automatic_compaction_triggers_at_configured_threshold(self):
        self.config["context"].update({"autoCompact": True, "contextWindowTokens": 2000,
                                        "compactThresholdTokens": 600, "compactRetainTokens": 10})
        self.respond = lambda body, _index: answer("AUTO_SUMMARY" if "tools" not in body
                                                   else "LARGE_RESPONSE_" + "x" * 800)
        result = self.invoke("chat", stdin="one\ntwo\nthree\nfour\n/exit\n")
        self.succeeded(result)
        self.assertEqual(result.stdout.count("LARGE_RESPONSE_"), 4)
        self.assertTrue(any("tools" not in request["body"] for request in self.requests))
        self.assertIn("AUTO_SUMMARY", json.dumps(self.requests[-1]["body"]))

    def test_auth_none_still_blocks_ambient_credential_in_prompt(self):
        self.config["model"]["apiKeyEnv"] = "TEST_PRIVATE_KEY"
        result = self.invoke("run", "--task", "A secret value: " + SYNTHETIC_SECRET,
                             environment={"TEST_PRIVATE_KEY": SYNTHETIC_SECRET})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])
        self.assertNotIn(SYNTHETIC_SECRET, result.stdout + result.stderr)

    def test_model_output_and_pii_are_blocked_before_display_and_persistence(self):
        self.config["model"]["apiKeyEnv"] = "TEST_PRIVATE_KEY"
        private_email = "synthetic.person@example.com"
        self.respond = lambda _body, _index: answer("Private values " + SYNTHETIC_SECRET + " " + private_email)
        result = self.invoke("run", "--task", "Find " + private_email,
                             environment={"TEST_PRIVATE_KEY": SYNTHETIC_SECRET})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])
        result = self.invoke("run", "--session", self.work / "session.jsonl",
                             environment={"TEST_PRIVATE_KEY": SYNTHETIC_SECRET})
        self.assertNotEqual(result.returncode, 0)
        session = self.work / "session.jsonl"
        for content in (result.stdout, result.stderr, session.read_text() if session.exists() else ""):
            self.assertNotIn(private_email, content)
            self.assertNotIn(SYNTHETIC_SECRET, content)

    def test_transient_provider_error_is_retried(self):
        self.respond = lambda _body, index: ((429, {"error": {"message": "rate limited"}})
                                             if index == 0 else answer())
        self.succeeded(self.invoke())
        self.assertEqual(len(self.requests), 2)

    def test_model_step_budget_stops_repeated_tools(self):
        self.config["limits"]["maxSteps"] = 2
        self.respond = lambda _body, index: tool("bash", {"command": self.shell("printf LOOP", 'Write-Output "LOOP"')},
                                                f"loop_{index}")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.requests), 2)

    def test_copied_script_runs_outside_repository_without_rust(self):
        extension = "ps1" if self.runtime == "powershell" else "sh"
        copy = self.work / f"standalone.{extension}"
        shutil.copyfile(SCRIPT_DIR / f"cognia-bootstrap.{extension}", copy)
        blocked = self.work / 'unavailable-runtimes'
        blocked.mkdir()
        marker = self.work / 'foreign-runtime-invoked'
        for executable in ('python', 'python3', 'node', 'perl', 'ruby', 'cognia-bootstrap'):
            shim = blocked / (executable + '.cmd' if os.name == 'nt' else executable)
            shim.write_text(('@echo off\necho blocked>"' + str(marker) + '"\nexit /b 99\n')
                            if os.name == 'nt' else '#!/bin/sh\nprintf blocked > "' + str(marker) + '"\nexit 99\n')
            shim.chmod(0o755)
        isolated_environment = {**self.environment,
            'PATH': str(blocked) + os.pathsep + self.environment.get('PATH', '')}
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        command = ([self.executable, "-NoLogo", "-NoProfile", "-File", str(copy)]
                   if self.runtime == "powershell" else [self.executable, str(copy)])
        result = subprocess.run([*command, "run", "--config", str(self.config_path), "--cwd", str(self.work)],
                                cwd=self.work, env=isolated_environment, capture_output=True, text=True, timeout=30)
        self.succeeded(result)
        self.assertFalse(marker.exists(), 'Agent attempted to invoke a foreign runtime')
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(json.loads(result.stdout)["status"], "completed")

    def test_runtime_is_native_shell_without_embedded_language_engine(self):
        extension = 'ps1' if self.runtime == 'powershell' else 'sh'
        source = (SCRIPT_DIR / f'cognia-bootstrap.{extension}').read_text()
        self.assertFalse('COGNIA_PYTHON' in source, 'Embedded Python engine is not a native shell implementation')
        self.assertIsNone(re.search(r'(?im)^\s*(?:exec\s+)?(?:python[0-9.]*|node|ruby|perl)\s', source),
                          'Agent must not delegate to another language runtime')
        if self.runtime == 'powershell':
            self.assertIsNone(re.search(r'(?i)Add-Type\s+-TypeDefinition', source),
                              'Use native PowerShell and built-in modules instead of an embedded C# engine')

    def test_config_env_matches_environment_manager_transport(self):
        config_name = "COGNIA_BOOTSTRAP_TEST_CONFIG"
        self.config["task"] = "Prepare a Unicode workspace: 示例"
        result = subprocess.run(self.command("run", "--config-env", config_name, "--cwd", self.work),
            cwd=self.work, env={**self.environment, config_name: json.dumps(self.config)},
            capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.succeeded(result)
        self.assertEqual(json.loads(result.stdout)["status"], "completed")
        self.assertIn("示例", json.dumps(self.requests[-1]["body"], ensure_ascii=False))

    def test_ambient_curl_configuration_cannot_inject_request_headers(self):
        curl_directory = self.work / 'ambient-curl'
        curl_directory.mkdir()
        (curl_directory / '.curlrc').write_text(
            'header = "Cookie: local-session=synthetic-ambient-cookie"\n', encoding='utf-8')
        self.succeeded(self.invoke(environment={'CURL_HOME': str(curl_directory)}))
        self.assertEqual(len(self.requests), 1)
        headers = {name.lower(): value for name, value in self.requests[0]['headers'].items()}
        self.assertNotIn('cookie', headers)

    def test_incomplete_sse_never_executes_provisional_tool_call(self):
        self.config["model"]["stream"] = True
        command = self.shell("printf unsafe > provisional.txt", 'Set-Content provisional.txt "unsafe"')
        event = {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0,
            "id": "provisional", "type": "function", "function": {"name": "bash",
            "arguments": json.dumps({"command": command})}}]}}]}
        self.respond = lambda _body, _index: ("data: " + json.dumps(event) + "\n\n").encode()
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.work / "provisional.txt").exists())

    def test_sse_tool_data_after_finished_response_is_rejected(self):
        self.config['model']['stream'] = True
        command = self.shell('printf unsafe > post-finish.txt',
                             'Set-Content post-finish.txt "unsafe"')
        events = [
            {'choices': [{'index': 0, 'delta': {'content': 'Completed'}, 'finish_reason': 'stop'}]},
            {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'late',
                'type': 'function', 'function': {'name': 'bash',
                    'arguments': json.dumps({'command': command})}}]}}]},
        ]
        payload = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + 'data: [DONE]\n\n'
        self.respond = lambda _body, _index: payload.encode()
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse((self.work / 'post-finish.txt').exists())

    def test_session_discards_incomplete_tail_before_replay(self):
        self.succeeded(self.invoke("chat", stdin="complete turn\n/exit\n"))
        session = self.work / "session.jsonl"
        with session.open("a", encoding="utf-8") as destination:
            destination.write('user\t' + json.dumps({"role": "user", "content": "incomplete tail",
                                                    "_cogniaSession": "turn-start"}) + '\n')
            destination.write('assistant\t{"role":"assistant","content":"partial response"}\n')
            destination.write('{malformed tail\n')
        self.succeeded(self.invoke("chat", stdin="resume complete prefix\n/exit\n"))
        body = json.dumps(self.requests[-1]["body"])
        self.assertIn("complete turn", body)
        self.assertNotIn("incomplete tail", body)
        self.assertNotIn("partial response", body)

    def test_failed_readiness_prevents_handoff(self):
        self.config.update({"checks": [{"name": "never-ready", "command": self.shell("false", 'throw "not ready"')}]})
        self.config["limits"]["maxSteps"] = 1
        marker = self.work / "must-not-launch.txt"
        code = "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('launched')"
        result = self.invoke("init", "--then", "--", sys.executable, "-c", code, marker)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())

    def test_fragmented_sse_text_reasoning_and_tool_arguments(self):
        self.config["model"].update({"stream": True, "showThinking": True})
        self.respond = lambda _body, index: (tool("bash", {"command": self.shell(
            "printf STREAM_TOOL_OK", 'Write-Output "STREAM_TOOL_OK"')}, reasoning="THINK_TOOL")
            if index == 0 else answer("STREAM_DONE", "THINK_FINAL"))
        result = self.invoke("chat", stdin="stream\n/exit\n")
        self.succeeded(result)
        self.assertIn("STREAM_DONE", result.stdout)
        self.assertIn("STREAM_TOOL_OK", self.tool_results()[-1]["output"])
        self.assertIn("THINK_TOOL", result.stderr)
        self.assertIn("THINK_FINAL", result.stderr)
        self.assertNotIn("THINK_FINAL", result.stdout)
        self.assertTrue(any(message.get("reasoning_content") == "THINK_TOOL"
                            for message in self.requests[-1]["body"]["messages"]))

    def test_manual_compaction_uses_model_summary(self):
        self.config["context"]["compactRetainTokens"] = 10
        self.respond = lambda body, _index: answer("SUMMARY_CHECKPOINT" if "tools" not in body
                                                   else "COMPLETED_" + "x" * 800)
        self.succeeded(self.invoke("chat", stdin="old turn\nrecent turn\n/compact\nnew turn\n/exit\n"))
        self.assertTrue(any("tools" not in request["body"] for request in self.requests))
        self.assertIn("SUMMARY_CHECKPOINT", json.dumps(self.requests[-1]["body"]))
        self.assertIn("recent turn", json.dumps(self.requests[-1]["body"]))
        self.assertNotIn('"content": "old turn"', json.dumps(self.requests[-1]["body"]))

    def test_context_overflow_summarizes_and_retries(self):
        self.config["context"].update({"autoCompact": True, "compactThresholdTokens": 50000,
                                        "compactRetainTokens": 10})
        overflowed = False
        def respond(body, _index):
            nonlocal overflowed
            if "tools" not in body:
                return answer("OVERFLOW_SUMMARY")
            if body["messages"][-1]["content"] == "overflow request" and not overflowed:
                overflowed = True
                return 400, {"error": {"code": "context_length_exceeded", "message": "maximum context length exceeded"}}
            return answer("LONG_" + "x" * 800)
        self.respond = respond
        self.succeeded(self.invoke("chat", stdin="old history\nrecent history\noverflow request\n/exit\n"))
        self.assertTrue(overflowed)
        self.assertIn("OVERFLOW_SUMMARY", json.dumps(self.requests[-1]["body"]))

    def test_tool_pruning_keeps_head_tail_and_status(self):
        self.config["context"].update({"pruneThresholdBytes": 256, "pruneHeadBytes": 64, "pruneTailBytes": 32})
        command = self.shell('printf HEAD_MARKER; for ((i=0;i<400;i++)); do printf abcde; done; printf TAIL_MARKER',
                             '[Console]::Write("HEAD_MARKER" + ("x" * 2000) + "TAIL_MARKER")')
        self.respond = lambda _body, index: tool("bash", {"command": command}) if index == 0 else answer()
        self.succeeded(self.invoke())
        result = self.tool_results()[-1]
        self.assertIn("HEAD_MARKER", result["output"])
        self.assertIn("TAIL_MARKER", result["output"])
        self.assertLess(len(result["output"]), 1000)
        self.assertIn("exitCode", result)

    def test_init_reuse_changed_input_missing_output_and_handoff(self):
        source, output = self.work / "source.in", self.work / "build.out"
        source.write_text("FIRST")
        self.config.update({"setupCommand": self.shell("cp source.in build.out", "Copy-Item source.in build.out -Force"),
            "checks": [{"name": "ready", "command": self.shell("test -f build.out",
                'if (-not (Test-Path build.out)) { throw "not ready" }')}],
            "reuse": {"inputs": ["source.in"], "outputs": ["build.out"]}})
        state = self.work / "state.json"
        first = self.invoke("init", "--state", state)
        self.succeeded(first)
        self.assertEqual(json.loads(first.stdout)["status"], "ready")
        reused = self.invoke("init", "--state", state)
        self.succeeded(reused)
        self.assertTrue(json.loads(reused.stdout)["reused"])
        source.write_text("SECOND")
        changed = self.invoke("init", "--state", state)
        self.succeeded(changed)
        self.assertFalse(json.loads(changed.stdout)["reused"])
        self.assertEqual(output.read_text(), "SECOND")
        output.unlink()
        self.succeeded(self.invoke("init", "--state", state))
        self.assertTrue(output.exists())
        marker = self.work / "handoff.json"
        code = "import json,pathlib,sys;pathlib.Path(sys.argv[1]).write_text(json.dumps(sys.argv[2:]))"
        handed = self.invoke("init", "--state", state, "--then", "--", sys.executable, "-c", code, marker,
                             "argument with spaces", "literal$argument")
        self.succeeded(handed)
        self.assertEqual(json.loads(marker.read_text()), ["argument with spaces", "literal$argument"])
        self.assertEqual(self.requests, [])

    def test_invalid_reserved_credential_and_budget_configuration(self):
        for path, value in (("model.extraBody.messages", []), ("model.thinking.credentials.api_key", "secret"),
                            ("model.extraBody.metadata", '{"api_key":"nested-secret"}'),
                            ("limits.maxSteps", 0), ("reuse.inputs", ["../escape"])):
            with self.subTest(path=path):
                result = self.invoke("run", "--set", path + "=" + json.dumps(value))
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests, [])

    def test_command_timeout_returns_control_and_stops_late_writes(self):
        self.config["limits"]["commandTimeoutSecs"] = 1
        command = self.shell("sleep 4; printf leaked > late-write.txt",
                             'Start-Sleep -Seconds 4; Set-Content late-write.txt "leaked"')
        self.respond = lambda _body, index: tool("bash", {"command": command}) if index == 0 else answer()
        started = time.monotonic()
        self.succeeded(self.invoke())
        self.assertLess(time.monotonic() - started, 15)
        time.sleep(4)
        self.assertFalse((self.work / "late-write.txt").exists())
        result = self.tool_results()[-1]
        self.assertTrue(result.get("timedOut") or "timeout" in json.dumps(result).lower())

    @unittest.skipIf(os.name == 'nt', 'Explicit Bash interpreter lifecycle on a Unix host')
    def test_exiting_shell_cleans_up_background_children(self):
        self.config['tools'].update({'shellExecutable': '/bin/bash',
                                     'shellArgs': ['--noprofile', '--norc']})
        command = '(sleep 4; printf late > background-after-exit.txt) & exit 0'
        self.respond = lambda _body, index: tool('bash', {'command': command}) if index == 0 else answer()
        self.succeeded(self.invoke())
        time.sleep(4.5)
        self.assertFalse((self.work / 'background-after-exit.txt').exists())

    @unittest.skipIf(os.name == "nt", "POSIX PTY signal regression; Windows runs remaining contracts natively")
    def test_ctrl_c_cancels_request_and_shell_then_accepts_next_turn(self):
        import errno
        import fcntl
        import pty
        import select
        import termios

        def respond(body, _index):
            current = next(message["content"] for message in reversed(body["messages"])
                           if message["role"] == "user")
            if current == "slow request":
                time.sleep(5)
                return answer("CANCELLED_REQUEST_MUST_NOT_PERSIST")
            if current == "slow tool":
                return tool("bash", {"command": self.shell(
                    "printf started > tool-started.txt; sleep 5; printf leaked > cancelled-write.txt",
                    'Set-Content tool-started.txt "started"; Start-Sleep -Seconds 5; Set-Content cancelled-write.txt "leaked"')})
            return answer("RECOVERED_AFTER_CANCEL")

        self.respond = respond
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        master, slave = pty.openpty()

        def initialize_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        process = subprocess.Popen(self.command("chat", "--config", self.config_path, "--cwd", self.work),
            stdin=slave, stdout=slave, stderr=slave, env=self.environment, cwd=self.work,
            preexec_fn=initialize_terminal)
        buffer = b""

        def wait_for(needle, timeout=12):
            nonlocal buffer
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if needle.encode() in buffer:
                    return
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    try:
                        buffer += os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
            self.fail(f"Missing terminal marker {needle!r}: {buffer.decode(errors='replace')}")

        try:
            wait_for("> ")
            buffer = b""
            os.write(master, b"slow request\n")
            deadline = time.monotonic() + 8
            while not self.requests and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(self.requests)
            os.write(master, b"\x03")
            wait_for("> ", 4)
            buffer = b""
            os.write(master, b"slow tool\n")
            deadline = time.monotonic() + 8
            while not (self.work / "tool-started.txt").exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue((self.work / "tool-started.txt").exists())
            os.write(master, b"\x03")
            wait_for("> ", 4)
            buffer = b""
            os.write(master, b"recover\n")
            wait_for("RECOVERED_AFTER_CANCEL")
            wait_for("> ")
            os.write(master, b"/exit\n")
            deadline = time.monotonic() + 8
            while process.poll() is None and time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    try:
                        os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
            self.assertEqual(process.wait(timeout=8), 0)
            time.sleep(5)
            self.assertFalse((self.work / "cancelled-write.txt").exists())
            session = (self.work / "session.jsonl").read_text()
            self.assertNotIn("slow request", session)
            self.assertNotIn("slow tool", session)
            self.assertIn("recover", session)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except PermissionError:
                    process.kill()
                process.wait(timeout=5)
            os.close(master)
            os.close(slave)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", choices=("bash", "powershell", "all"), default="all")
    options, test_arguments = parser.parse_known_args()
    selected = ("bash", "powershell") if options.runtime == "all" else (options.runtime,)
    for runtime in selected:
        executable = (os.environ.get("COGNIA_TEST_PWSH") or shutil.which("pwsh")) if runtime == "powershell" else shutil.which("bash")
        if not executable:
            parser.error(f"{runtime} runtime unavailable; install it or select --runtime explicitly")
        name = "PowerShellTests" if runtime == "powershell" else "BashTests"
        globals()[name] = type(name, (StandaloneContract, unittest.TestCase),
                               {"runtime": runtime, "executable": executable})
    unittest.main(argv=[sys.argv[0], *test_arguments], verbosity=2)


if __name__ == "__main__":
    main()
