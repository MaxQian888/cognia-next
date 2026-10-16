import asyncio
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("desktop_server", pathlib.Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class AuthenticationTests(unittest.TestCase):
    def request(self, kind, headers, extensions=None, path="/", method="GET"):
        events = []

        async def application(scope, receive, send):
            events.append({"allowed": True})

        async def send(value):
            events.append(value)

        asyncio.run(server.TokenAuth(application, "a" * 64)(
            {"type": kind, "headers": headers, "extensions": extensions or {},
             "path": path, "method": method}, None, send))
        return events

    def test_missing_wrong_duplicate_and_browser_origin_are_denied(self):
        for headers in [[], [(b"x-cognia-sandbox-token", b"wrong")],
                        [(b"x-cognia-sandbox-token", b"a" * 64)] * 2,
                        [(b"x-cognia-sandbox-token", b"a" * 64), (b"origin", b"http://localhost")]]:
            self.assertEqual(self.request("http", headers)[0]["status"], 401)
            self.assertEqual(self.request("websocket", headers, {"websocket.http.response": {}})[0]["status"], 401)

    def test_authenticated_native_http_and_websocket_reach_upstream(self):
        for kind in ["http", "websocket"]:
            self.assertEqual(self.request(kind, [(b"x-cognia-sandbox-token", b"a" * 64)]), [{"allowed": True}])

    def test_websocket_without_denial_extension_closes_before_accept(self):
        self.assertEqual(self.request("websocket", [])[0], {"type": "websocket.close", "code": 1008})

    def test_release_identity_requires_guest_auth_and_is_not_cached(self):
        self.assertEqual(self.request("http", [], path="/cognia/health")[0]["status"], 401)
        events = self.request("http", [(b"x-cognia-sandbox-token", b"a" * 64)], path="/cognia/health")
        self.assertEqual(events[0]["status"], 200)
        self.assertIn((b"cache-control", b"no-store"), events[0]["headers"])
        self.assertEqual(json.loads(events[1]["body"]), {
            "protocol": "computer-server-0.3.46", "recipeRevision": "5", "serverVersion": "0.3.46"
        })
        self.assertNotIn(b"a" * 64, events[1]["body"])


@unittest.skipUnless(sys.platform == "linux", "Managed listener attestation requires Linux SO_ACCEPTCONN")
class ManagedListenerTests(unittest.TestCase):
    def test_unix_listener_stays_open_but_cannot_survive_child_exec(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(pathlib.Path(directory) / "gui.sock"))
            listener.listen(1)
            descriptor = listener.fileno()
            os.set_inheritable(descriptor, True)
            self.assertEqual(server.prepare_managed_listener(descriptor), descriptor)
            self.assertFalse(os.get_inheritable(descriptor))
            self.assertEqual(listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN), 1)
            # Even a child accidentally launched without close_fds cannot keep
            # the guard's listener, because startup made it close-on-exec.
            child = subprocess.run([sys.executable, "-c",
                "import os,sys\ntry: os.fstat(int(sys.argv[1]))\nexcept OSError: sys.exit(0)\nsys.exit(1)",
                str(descriptor)], close_fds=False, check=False)
            self.assertEqual(child.returncode, 0)

    def test_tcp_unconnected_unix_and_non_socket_descriptors_are_refused(self):
        with socket.socket() as tcp, socket.socket(socket.AF_UNIX) as unconnected, tempfile.TemporaryFile() as regular:
            tcp.bind(("127.0.0.1", 0))
            tcp.listen(1)
            for descriptor in (tcp.fileno(), unconnected.fileno(), regular.fileno(), -1):
                with self.subTest(descriptor=descriptor), self.assertRaises(RuntimeError):
                    server.prepare_managed_listener(descriptor)
            # Validation owns only a duplicate and cannot close caller handles.
            self.assertEqual(tcp.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN), 1)
            regular.write(b"still-open")

    def test_managed_server_uses_only_preopened_listener_and_docker_keeps_tcp(self):
        configurations = []
        upstream = types.ModuleType("computer_server.main")
        upstream.app = object()
        uvicorn = types.ModuleType("uvicorn")
        uvicorn.Config = lambda app, **options: configurations.append(options) or options
        uvicorn.Server = lambda config: types.SimpleNamespace(run=lambda: None)
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(pathlib.Path(directory) / "gui.sock"))
            listener.listen(1)
            descriptor = listener.fileno()
            with mock.patch.dict(sys.modules, {"computer_server.main": upstream, "uvicorn": uvicorn}), \
                    mock.patch.object(server.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=lambda *args: 0)):
                server.serve("a" * 64, lambda: False, listener_fd=listener.fileno())
                server.serve("a" * 64, lambda: False)
        self.assertEqual(configurations, [
            {"log_level": "info", "fd": descriptor},
            {"log_level": "info", "host": "0.0.0.0", "port": 8000},
        ])


if __name__ == "__main__":
    unittest.main()
