import importlib.util
import pathlib
import subprocess
import sys
import types
import unittest
from unittest import mock

IMAGE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("desktop_startup", IMAGE / "startup.py")
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class StartupBoundaryTests(unittest.TestCase):
    def setUp(self):
        guard = mock.patch.object(startup.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=lambda *args: 0))
        environment = mock.patch.dict(startup.os.environ, {"COGNIA_CUA_AUTH_TOKEN": "a" * 64})
        guard.start()
        environment.start()
        self.addCleanup(guard.stop)
        self.addCleanup(environment.stop)

    def test_missing_managed_listener_refuses_before_any_desktop_child(self):
        fake_server = types.SimpleNamespace(prepare_managed_listener=mock.Mock(
            side_effect=RuntimeError("Managed desktop listener is unavailable")))
        fake_spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
        with mock.patch.object(sys, "argv", ["startup.py", "--managed"]), \
                mock.patch.object(startup.importlib.util, "spec_from_file_location", return_value=fake_spec), \
                mock.patch.object(startup.importlib.util, "module_from_spec", return_value=fake_server), \
                mock.patch.object(startup.subprocess, "Popen") as child:
            with self.assertRaisesRegex(RuntimeError, "listener is unavailable"):
                startup.main()
            child.assert_not_called()

    def test_unknown_modes_refuse_before_loading_server(self):
        with mock.patch.object(sys, "argv", ["startup.py", "--unsafe"]), \
                mock.patch.object(startup.importlib.util, "spec_from_file_location") as loader:
            with self.assertRaisesRegex(RuntimeError, "Invalid desktop startup mode"):
                startup.main()
            loader.assert_not_called()

    def test_entrypoint_refuses_invalid_modes_before_preparing_runtime(self):
        for arguments in (["--unknown"], ["--managed", "--extra"]):
            result = subprocess.run(["/bin/sh", str(IMAGE / "entrypoint.sh"), *arguments],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr.strip(), "Invalid desktop startup mode")

    @unittest.skipIf(pathlib.Path("/usr/local/bin/cognia-desktop-guest").exists(),
                     "This refusal fixture requires a host without the guest guard")
    def test_managed_entrypoint_refuses_missing_guard_without_docker_fallback(self):
        result = subprocess.run(["/bin/sh", str(IMAGE / "entrypoint.sh"), "--managed"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "Managed desktop isolation guard is unavailable")


if __name__ == "__main__":
    unittest.main()
