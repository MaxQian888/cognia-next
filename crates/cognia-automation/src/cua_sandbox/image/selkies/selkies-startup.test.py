import importlib.util
import pathlib
import signal
import sys
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("selkies_startup", HERE / "selkies-startup.py")
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)

TOKEN = "ab" * 32


class FakeChild:
    def __init__(self, exits=True):
        self.pid = 4242
        self.returncode = 0 if exits else None
        self.waited = 0

    def wait(self):
        self.waited += 1
        return self.returncode

    def poll(self):
        return self.returncode


class FlagTests(unittest.TestCase):
    def flags(self):
        return dict(flag[2:].split("=", 1) for flag in startup.selkies_argv()[1:])

    def test_input_belongs_to_the_controller_alone(self):
        flags = self.flags()
        self.assertEqual(flags["enable-collab"], "false|locked")
        self.assertEqual(flags["mode"], "websockets")
        self.assertEqual(flags["enable-basic-auth"], "false")

    def test_every_side_channel_is_off(self):
        flags = self.flags()
        for name in ("audio-enabled", "microphone-enabled", "webcam-enabled", "gamepad-enabled",
                     "printing-enabled", "command-enabled", "enable-sharing", "enable-shared",
                     "enable-player2", "enable-player3", "enable-player4", "second-screen",
                     "enable-binary-clipboard", "clipboard-seamless"):
            self.assertEqual(flags[name], "false|locked", name)
        self.assertEqual(flags["enable-clipboard"], "false")
        self.assertEqual(flags["file-transfers"], "none")

    def test_the_desktop_keeps_its_size_and_falls_back_to_jpeg(self):
        flags = self.flags()
        self.assertEqual(flags["enable-resize"], "false|locked")
        self.assertEqual(flags["encoder"], "h264enc,jpeg")
        self.assertEqual(flags["use-cpu"], "true")


class EnvironmentTests(unittest.TestCase):
    def test_only_the_stream_credential_reaches_selkies(self):
        env = startup.selkies_env(TOKEN, {
            "DISPLAY": ":99", "HOME": "/home/cua", "PATH": "/usr/bin",
            "COGNIA_CUA_AUTH_TOKEN": "c" * 64, "DBUS_SESSION_BUS_ADDRESS": "unix:x",
        })
        self.assertEqual(env, {"DISPLAY": ":99", "HOME": "/home/cua", "PATH": "/usr/bin",
                               "SELKIES_MASTER_TOKEN": TOKEN})

    def test_the_master_token_is_popped_and_validated(self):
        environ = {"COGNIA_SELKIES_MASTER_TOKEN": TOKEN}
        self.assertEqual(startup.pop_master_token(environ), TOKEN)
        self.assertNotIn("COGNIA_SELKIES_MASTER_TOKEN", environ)
        for bad in ("", "a" * 63, "Z" * 64, "AB" * 32):
            with self.assertRaises(RuntimeError):
                startup.pop_master_token({"COGNIA_SELKIES_MASTER_TOKEN": bad})

    def test_startup_refuses_any_mode_argument(self):
        guard = types.SimpleNamespace(prctl=lambda *args: 0)
        with mock.patch.object(startup.ctypes, "CDLL", return_value=guard), \
                mock.patch.object(sys, "argv", ["selkies-startup.py", "--managed"]), \
                mock.patch.dict(startup.os.environ, {"COGNIA_SELKIES_MASTER_TOKEN": TOKEN}):
            with self.assertRaisesRegex(RuntimeError, "Invalid desktop startup mode"):
                startup.main()


class SupervisorTests(unittest.TestCase):
    def supervisor(self, popen, ready=lambda: True, clock=None):
        clock = clock or iter(range(0, 10_000))
        return startup.StreamSupervisor(
            TOKEN, {"DISPLAY": ":99"}, popen=popen, ready=ready,
            sleep=lambda _s: None, now=lambda: next(clock), killpg=mock.Mock())

    def test_selkies_starts_once_the_display_answers_with_its_own_session(self):
        answers = iter([False, False, True])
        popen = mock.Mock(side_effect=[FakeChild()] * (startup.MAX_RESTARTS + 1))
        supervisor = self.supervisor(popen, ready=lambda: next(answers))
        supervisor.run()
        argv = popen.call_args.args[0]
        options = popen.call_args.kwargs
        self.assertEqual(argv[0], startup.SELKIES)
        self.assertTrue(options["start_new_session"])
        self.assertEqual(options["env"]["SELKIES_MASTER_TOKEN"], TOKEN)
        # Repeated exits stop after the restart budget; the desktop stays up.
        self.assertEqual(popen.call_count, startup.MAX_RESTARTS + 1)

    def test_a_display_that_never_answers_starts_nothing(self):
        popen = mock.Mock()
        self.supervisor(popen, ready=lambda: False).run()
        popen.assert_not_called()

    def test_stop_terminates_the_process_group(self):
        child = FakeChild(exits=False)
        # Stopping before spawn spawns nothing.
        popen = mock.Mock(return_value=child)
        supervisor = self.supervisor(popen)
        supervisor.stop()
        supervisor.run()
        popen.assert_not_called()
        supervisor = self.supervisor(mock.Mock(return_value=child))
        supervisor._child = child
        supervisor.stop()
        supervisor._killpg.assert_any_call(child.pid, signal.SIGTERM)
        supervisor._killpg.assert_any_call(child.pid, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
