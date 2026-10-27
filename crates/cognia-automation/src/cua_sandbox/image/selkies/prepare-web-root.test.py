import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("prepare_web_root", HERE / "prepare-web-root.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareWebRootTests(unittest.TestCase):
    def fixture(self):
        return ";".join(marker for marker, count, _ in prepare.SIGNALS for _ in range(count)).encode()

    def test_unknown_client_code_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Unexpected Selkies client bundle"):
            prepare.instrument_core(b"changed upstream")

    def test_every_expected_anchor_is_instrumented_and_counts_are_checked(self):
        content = self.fixture()
        with mock.patch.object(prepare, "CORE_SHA256", hashlib.sha256(content).hexdigest()):
            patched = prepare.instrument_core(content)
        for _, count, signal in prepare.SIGNALS:
            self.assertEqual(patched.count(f'new Event("cognia-selkies-{signal}")'), count)
        missing = content.replace(b"Ee=performance.now()", b"0", 1)
        with mock.patch.object(prepare, "CORE_SHA256", hashlib.sha256(missing).hexdigest()):
            with self.assertRaisesRegex(RuntimeError, "anchor count: received"):
                prepare.instrument_core(missing)

    def test_the_bridge_loads_before_the_original_entrypoint_and_other_assets_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            destination = Path(directory) / "web"
            (source / "assets").mkdir(parents=True)
            content = self.fixture()
            entry = prepare.CORE_IMPORT.encode()
            (source / prepare.ENTRY_ASSET).write_bytes(entry)
            (source / prepare.CORE_ASSET).write_bytes(content)
            (source / "index.html").write_text(prepare.MODULE_TAG)
            (source / "asset.css").write_text("fixture")
            with mock.patch.object(prepare, "CORE_SHA256", hashlib.sha256(content).hexdigest()), \
                    mock.patch.object(prepare, "ENTRY_SHA256", hashlib.sha256(entry).hexdigest()):
                prepare.prepare_web_root(source, destination)
            index = (destination / "index.html").read_text()
            self.assertLess(index.index("cognia-stream-health.js"), index.index(prepare.MODULE_TAG))
            self.assertEqual((destination / "asset.css").read_text(), "fixture")
            self.assertEqual((destination / "cognia-stream-health.js").read_bytes(), (HERE / "stream-health.js").read_bytes())
            self.assertIn('cognia-selkies-output', (destination / prepare.CORE_ASSET).read_text())
            self.assertIn(prepare.CORE_IMPORT, (destination / prepare.ENTRY_ASSET).read_text())

    def test_changed_entrypoint_is_rejected_before_copying(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            destination = Path(directory) / "web"
            (source / "assets").mkdir(parents=True)
            content = self.fixture()
            entry = prepare.CORE_IMPORT.encode()
            (source / prepare.ENTRY_ASSET).write_bytes(entry)
            (source / prepare.CORE_ASSET).write_bytes(content)
            (source / "index.html").write_text("<html></html>")
            with mock.patch.object(prepare, "CORE_SHA256", hashlib.sha256(content).hexdigest()), \
                    mock.patch.object(prepare, "ENTRY_SHA256", hashlib.sha256(entry).hexdigest()):
                with self.assertRaisesRegex(RuntimeError, "entry point"):
                    prepare.prepare_web_root(source, destination)
            self.assertFalse(destination.exists())

    def test_a_changed_runtime_import_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            (source / "assets").mkdir(parents=True)
            (source / prepare.ENTRY_ASSET).write_text("import('another-core.js')")
            with self.assertRaisesRegex(RuntimeError, "runtime import"):
                prepare.prepare_web_root(source, Path(directory) / "web")


if __name__ == "__main__":
    unittest.main()
