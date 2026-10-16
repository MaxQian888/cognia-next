"""Offline fixture coverage of the actual installer, without provider access."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("handoff_guest", Path(__file__).with_name("handoff_guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cognia-handoff-fixture-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "source"
        self.repo.mkdir()
        self.git("init", ".")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "check.json").write_text('{"criterion":"visible"}')
        self.git("add", "check.json")
        self.git("commit", "-m", "fixture")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.git("update-ref", "refs/cognia/acceptance", self.commit)
        self.bundle = self.root / "source.bundle"
        self.git("bundle", "create", str(self.bundle), "refs/cognia/acceptance")
        self.bundle_bytes = self.bundle.read_bytes()
        self.files = [("check.json", (self.repo / "check.json").read_bytes())]
        self.request, self.payload = self.packet()

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.check_output(["/usr/bin/git", *args], cwd=self.repo, stderr=subprocess.DEVNULL)

    def packet(self):
        manifest = {
            "version": 1, "commit": self.commit,
            "bundleBytes": len(self.bundle_bytes),
            "bundleSha256": hashlib.sha256(self.bundle_bytes).hexdigest(),
            "files": [{"path": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for path, data in self.files],
        }
        raw = json.dumps(manifest, separators=(",", ":"))
        request = {"operationId": str(uuid.uuid4()), "manifest": raw, "manifestDigest": hashlib.sha256(raw.encode()).hexdigest(), "deadlineAtMs": int(time.time() * 1000) + 30000, "launch": None}
        return request, self.bundle_bytes + b"".join(data for _, data in self.files)

    def install(self, payload=None, request=None):
        # The fixture uses its own current uid; production main requires root
        # and resolves the pinned image's cua account. No provider is involved.
        account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        with patch.object(guest.pwd, "getpwnam", return_value=account), patch.object(guest.shutil, "disk_usage", return_value=types.SimpleNamespace(free=16 * 1024**3)), patch.object(guest.os, "posix_fallocate", create=True):
            return guest.install(request or self.request, io.BytesIO(self.payload if payload is None else payload), self.root / "destination")

    def test_actual_bundle_reconstruction_pins_commit_and_selected_files(self):
        (self.repo / "check.json").write_text("moving branch")
        self.git("add", ".")
        self.git("commit", "-m", "later")
        result = self.install()
        workspace = Path(result["workspace"])
        self.assertEqual((workspace / ".git" / "HEAD").read_text().strip(), self.commit)
        self.assertEqual((workspace / "check.json").read_bytes(), self.files[0][1])
        self.assertEqual((workspace.parent / "acceptance/check.json").read_bytes(), self.files[0][1])
        self.assertFalse(result["launched"])
        self.assertFalse((workspace.parent / "source.bundle").exists())
        self.assertFalse((workspace.parent / ".reservation").exists())

    def test_duplicate_operation_never_overwrites_workspace(self):
        result = self.install()
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual((Path(result["workspace"]) / "check.json").read_bytes(), self.files[0][1])

    def test_corrupt_truncated_and_extra_stream_remove_partial_directory(self):
        for payload in [self.payload[:-1], b"bad" + self.payload[3:], self.payload + b"unexpected"]:
            with self.subTest(size=len(payload)):
                with self.assertRaises(ValueError):
                    self.install(payload=payload)
                self.assertEqual(list((self.root / "destination").iterdir()), [])

    def test_wrong_exact_commit_is_rejected_and_cleaned(self):
        self.commit = "f" * 40
        self.request, self.payload = self.packet()
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(list((self.root / "destination").iterdir()), [])

    def test_recovery_bundle_needs_prerequisites_before_guest_transfer(self):
        base = self.commit
        (self.repo / "new").write_text("incremental")
        self.git("add", ".")
        self.git("commit", "-m", "incremental")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.git("update-ref", "refs/cognia/acceptance", self.commit)
        self.git("bundle", "create", str(self.bundle), "refs/cognia/acceptance", "^" + base)
        self.bundle_bytes = self.bundle.read_bytes()
        self.request, self.payload = self.packet()
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(list((self.root / "destination").iterdir()), [])

    def test_source_symlink_is_rejected_before_launch(self):
        (self.repo / "escape").symlink_to("/etc/passwd")
        self.git("add", "escape")
        self.git("commit", "-m", "symlink")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.git("update-ref", "refs/cognia/acceptance", self.commit)
        self.git("bundle", "create", str(self.bundle), "refs/cognia/acceptance")
        self.bundle_bytes = self.bundle.read_bytes()
        self.request, self.payload = self.packet()
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(list((self.root / "destination").iterdir()), [])

    def test_selected_credentials_traversal_and_special_paths_refused(self):
        for value in ["../outside", "/outside", "a/../b", "a//b", "a\\b", ".env", "a/.env.local", ".git/config", ".ssh/id_rsa", "x.key", "cookies.sqlite"]:
            with self.subTest(path=value), self.assertRaises(ValueError):
                guest.safe_path(value)

    def test_manifest_tampering_and_limits_refused_before_writes(self):
        for mutation in [
            lambda m: m.update(bundleBytes=guest.BUNDLE_LIMIT + 1),
            lambda m: m["files"][0].update(bytes=guest.FILE_LIMIT + 1),
            lambda m: m.update(files=m["files"] * 101),
            lambda m: m.update(files=m["files"] * 2),
            lambda m: m.update(commit="main"),
        ]:
            request = dict(self.request)
            manifest = json.loads(request["manifest"])
            mutation(manifest)
            request["manifest"] = json.dumps(manifest)
            request["manifestDigest"] = hashlib.sha256(request["manifest"].encode()).hexdigest()
            with self.assertRaises(ValueError):
                guest.validate(request)
        self.request["manifest"] += " "
        with self.assertRaises(ValueError):
            guest.validate(self.request)

    def test_expired_and_untrusted_launch_request_refused(self):
        for launch in [{"script": "dev;curl"}, {"script": "--prefix=/"}, {"argv": ["sh", "-c", "true"]}, {"script": "dev", "env": {"TOKEN": "secret"}}]:
            with self.assertRaises(ValueError):
                guest.validate({**self.request, "launch": launch})
        with self.assertRaises(ValueError):
            guest.validate({**self.request, "deadlineAtMs": 0})
        with self.assertRaises(ValueError):
            guest.validate({**self.request, "operationId": "../outside"})

    def test_exclusive_receiver_does_not_follow_or_overwrite_target(self):
        target = self.root / "target"
        target.write_bytes(b"original")
        link = self.root / "link"
        link.symlink_to(target)
        for path in [target, link]:
            with self.assertRaises(FileExistsError):
                guest.receive(io.BytesIO(b"replacement"), path, 11, hashlib.sha256(b"replacement").hexdigest())
        self.assertEqual(target.read_bytes(), b"original")

    def test_partial_file_hash_is_verified(self):
        with self.assertRaises(ValueError):
            guest.receive(io.BytesIO(b"corrupt"), self.root / "out", 7, "0" * 64)


if __name__ == "__main__":
    unittest.main()
