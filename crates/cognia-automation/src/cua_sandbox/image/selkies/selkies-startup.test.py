import importlib.util
import pathlib
import signal
import sys
import threading
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("selkies_startup", HERE / "selkies-startup.py")
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)

TOKEN = "ab" * 32


class FakeChild:
    def __init__(self, exits=True, on_wait=lambda: None):
        self.pid = 4242
        self.returncode = 0 if exits else None
        self.waited = 0
        self.on_wait = on_wait

    def wait(self):
        self.waited += 1
        self.on_wait()
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
        child = FakeChild()
        popen = mock.Mock(return_value=child)
        supervisor = self.supervisor(popen, ready=lambda: next(answers))
        child.on_wait = supervisor.stop
        supervisor.run()
        argv = popen.call_args.args[0]
        options = popen.call_args.kwargs
        self.assertEqual(argv[0], startup.SELKIES)
        self.assertTrue(options["start_new_session"])
        self.assertEqual(options["env"]["SELKIES_MASTER_TOKEN"], TOKEN)
        self.assertEqual(popen.call_count, 1)

    def test_a_display_that_never_answers_starts_nothing(self):
        popen = mock.Mock()
        self.supervisor(popen, ready=lambda: False).run()
        popen.assert_not_called()

    def test_recovery_continues_after_six_exits_with_capped_backoff(self):
        delays = []
        supervisor = None
        children = []

        def exited():
            if len(children) == 10:
                supervisor.stop()

        def spawn(*_args, **_kwargs):
            child = FakeChild(on_wait=exited)
            children.append(child)
            return child

        supervisor = self.supervisor(mock.Mock(side_effect=spawn))
        supervisor._sleep = delays.append
        supervisor.run()
        self.assertEqual(len(children), 10)
        self.assertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30, 30])

    def test_transient_spawn_failure_is_retried(self):
        supervisor = self.supervisor(mock.Mock())
        child = FakeChild(on_wait=supervisor.stop)
        supervisor._popen.side_effect = [OSError("temporary process resource limit"), child]
        supervisor.run()
        self.assertEqual(supervisor._popen.call_count, 2)

    def test_a_stable_run_resets_the_backoff(self):
        clock = [0]
        durations = iter([0, 0, 70, 0])
        delays = []
        children = []
        supervisor = None

        def exited():
            clock[0] += next(durations)
            if len(children) == 4:
                supervisor.stop()

        def spawn(*_args, **_kwargs):
            child = FakeChild(on_wait=exited)
            children.append(child)
            return child

        supervisor = startup.StreamSupervisor(
            TOKEN, {"DISPLAY": ":99"}, popen=spawn, ready=lambda: True,
            sleep=delays.append, now=lambda: clock[0], killpg=mock.Mock())
        supervisor.run()
        self.assertEqual(len(children), 4)
        self.assertEqual(delays, [1, 2, 1])

    def test_stop_interrupts_restart_backoff_without_another_spawn(self):
        exited = threading.Event()
        child = FakeChild(on_wait=exited.set)
        popen = mock.Mock(return_value=child)
        supervisor = startup.StreamSupervisor(
            TOKEN, {"DISPLAY": ":99"}, popen=popen, ready=lambda: True, killpg=mock.Mock())
        thread = threading.Thread(target=supervisor.run)
        thread.start()
        try:
            self.assertTrue(exited.wait(1))
            supervisor.stop()
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(popen.call_count, 1)
        finally:
            supervisor.stop()
            thread.join(3)

    def test_shutdown_polling_still_waits_after_the_stop_event_is_set(self):
        supervisor = self.supervisor(mock.Mock(), clock=iter([0, 0, 1, 2, 3]))
        supervisor._child = FakeChild(exits=False)
        supervisor._sleep = mock.Mock()
        with mock.patch.object(startup.time, "sleep") as shutdown_sleep:
            supervisor.stop()
        self.assertEqual(shutdown_sleep.call_args_list, [mock.call(0.05)] * 3)
        supervisor._sleep.assert_not_called()

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
