import importlib.util
import logging
import pathlib
import unittest

HERE = pathlib.Path(__file__).parent


def load():
    spec = importlib.util.spec_from_file_location("cognia_sitecustomize", HERE / "sitecustomize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DropViewerFrameAcksTest(unittest.TestCase):
    def setUp(self):
        self.logger = logging.getLogger("ws")
        self.before = list(self.logger.filters)
        self.module = load()

    def tearDown(self):
        self.logger.filters[:] = self.before

    def logged(self, message):
        with self.assertLogs("ws", level="WARNING") as captured:
            self.logger.warning(message)
            self.logger.warning("marker")
        return [line for line in captured.output if "marker" not in line]

    def test_a_viewer_frame_ack_is_not_logged(self):
        self.assertEqual(
            self.logged("DENIED unauthorized message from viewer ('172.17.0.1', 54600): CLIENT_FRAME_ACK 1111 29..."),
            [],
        )

    def test_other_refused_viewer_messages_are_still_logged(self):
        self.assertEqual(
            len(self.logged("DENIED unauthorized message from viewer ('172.17.0.1', 54600): kd,65...")),
            1,
        )

    def test_unrelated_warnings_pass(self):
        self.assertEqual(len(self.logged("Malformed CLIENT_FRAME_ACK from 172.17.0.1: x")), 1)

    def test_it_attaches_to_the_selkies_logger(self):
        self.assertTrue(
            any(isinstance(f, self.module.DropViewerFrameAcks) for f in self.logger.filters)
        )


if __name__ == "__main__":
    unittest.main()
