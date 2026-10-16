"""Offline raw-object importer fixtures; no provider or privileged execution."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch, MagicMock

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
            "version": 2,
            "sourceTreeSha256": self.source_proof()[0], "sourceFileCount": self.source_proof()[1], "sourceBytes": self.source_proof()[2], "commit": self.commit,
            "bundleBytes": len(self.bundle_bytes),
            "bundleSha256": hashlib.sha256(self.bundle_bytes).hexdigest(),
            "files": [{"path": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for path, data in self.files],
        }
        raw = json.dumps(manifest, separators=(",", ":"))
        request = {"operationId": str(uuid.uuid4()), "manifest": raw, "manifestDigest": hashlib.sha256(raw.encode()).hexdigest(), "deadlineAtMs": int(time.time() * 1000) + 30000, "launch": None}
        return request, self.bundle_bytes + b"".join(data for _, data in self.files)

    def source_proof(self):
        entries = []
        listing = self.git("ls-tree", "-rz", "--full-tree", "-l", self.commit)
        for record in listing[:-1].split(b"\0") if listing else []:
            fields, path = record.split(b"\t", 1)
            mode, kind, oid, size = fields.split()
            blob = self.git("cat-file", "blob", oid.decode()) if kind == b"blob" else b""
            entries.append((path, mode == b"100755", blob))
        total = sum(len(blob) for _, _, blob in entries)
        proof = hashlib.sha256(b"cognia-source-tree-v1\0" + len(entries).to_bytes(8, "big") + total.to_bytes(8, "big"))
        for path, executable, blob in sorted(entries):
            proof.update(len(path).to_bytes(4, "big") + path + bytes([executable]) + len(blob).to_bytes(8, "big") + hashlib.sha256(blob).digest())
        return proof.hexdigest(), len(entries), total

    def install(self, request=None):
        input_root, output = self.root / "input", self.root / "output"
        input_root.mkdir(exist_ok=True)
        output.mkdir(exist_ok=True)
        (input_root / "source.bundle").write_bytes(self.bundle_bytes)
        for index, (_, data) in enumerate(self.files):
            (input_root / ("file-" + str(index))).write_bytes(data)
        guest.import_source(request or self.request, input_root, output)
        return output / "workspace"

    def rebundle(self):
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.git("update-ref", "refs/cognia/acceptance", self.commit)
        self.git("bundle", "create", str(self.bundle), "refs/cognia/acceptance")
        self.bundle_bytes = self.bundle.read_bytes()
        self.request, self.payload = self.packet()

    def test_actual_bundle_reconstruction_pins_commit_and_selected_files(self):
        (self.repo / "check.json").write_text("moving branch")
        self.git("add", ".")
        self.git("commit", "-m", "later")
        workspace = self.install()
        self.assertEqual((workspace / ".git" / "HEAD").read_text().strip(), self.commit)
        self.assertEqual((workspace / "check.json").read_bytes(), self.files[0][1])
        self.assertEqual((workspace.parent / "acceptance/check.json").read_bytes(), self.files[0][1])
        self.assertEqual(sorted(p.name for p in workspace.parent.iterdir()), ["acceptance", "workspace"])

    def test_duplicate_import_never_overwrites_workspace(self):
        workspace = self.install()
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual((workspace / "check.json").read_bytes(), self.files[0][1])

    def test_raw_objects_preserve_ident_crlf_modes_and_nonutf8_paths(self):
        (self.repo / ".gitattributes").write_bytes(b"*.txt ident text eol=crlf\n")
        (self.repo / "raw.txt").write_bytes(b"$Id$\nhello\n")
        (self.repo / "script").write_bytes(b"#!/bin/sh\n")
        (self.repo / "script").chmod(0o755)
        raw_name = os.fsencode(self.repo) + b"/raw-\xff"
        if sys.platform == "linux":
            with open(raw_name, "wb") as out:
                out.write(b"raw path")
        self.git("add", ".")
        self.git("commit", "-m", "attributes")
        self.rebundle()
        workspace = self.install()
        self.assertEqual((workspace / "raw.txt").read_bytes(), b"$Id$\nhello\n")
        self.assertTrue((workspace / "script").stat().st_mode & 0o100)
        if sys.platform == "linux":
            with open(os.fsencode(workspace) + b"/raw-\xff", "rb") as source:
                self.assertEqual(source.read(), b"raw path")

    def test_wrong_tree_digest_refuses_even_correct_commit(self):
        request = dict(self.request)
        manifest = json.loads(request["manifest"])
        manifest["sourceTreeSha256"] = "0" * 64
        request["manifest"] = json.dumps(manifest)
        request["manifestDigest"] = hashlib.sha256(request["manifest"].encode()).hexdigest()
        with self.assertRaises(ValueError):
            self.install(request=request)

    def test_corrupt_bundle_refused(self):
        self.bundle_bytes = b"bad" + self.bundle_bytes[3:]
        with self.assertRaises(ValueError):
            self.install()

    def test_recovery_bundle_requires_host_to_complete_prerequisites(self):
        base = self.commit
        (self.repo / "new").write_text("incremental")
        self.git("add", ".")
        self.git("commit", "-m", "incremental")
        self.rebundle()
        self.git("bundle", "create", str(self.bundle), "refs/cognia/acceptance", "^" + base)
        self.bundle_bytes = self.bundle.read_bytes()
        self.request, self.payload = self.packet()
        with self.assertRaises(ValueError):
            self.install()

    def test_source_symlink_is_rejected_before_materialization(self):
        (self.repo / "escape").symlink_to("/etc/passwd")
        self.git("add", "escape")
        self.git("commit", "-m", "symlink")
        self.rebundle()
        with self.assertRaises(ValueError):
            self.install()

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

    def test_input_symlink_hardlink_and_wrong_hash_refused(self):
        source = self.root / "file"
        source.write_bytes(b"content")
        link = self.root / "link"
        link.symlink_to(source)
        with self.assertRaises(OSError):
            guest.checked_file(link, 7, hashlib.sha256(b"content").hexdigest())
        link.unlink()
        os.link(source, link)
        with self.assertRaises(ValueError):
            guest.checked_file(source, 7, hashlib.sha256(b"content").hexdigest())
        link.unlink()
        with self.assertRaises(ValueError):
            guest.checked_file(source, 7, "0" * 64)

    def test_git_transient_hardlink_is_only_tolerated_by_live_size_monitor(self):
        tree = self.root / "git-temporary"
        tree.mkdir()
        (tree / "temporary").write_bytes(b"raw object")
        os.link(tree / "temporary", tree / "object")
        guest.size_bound(tree, git_running=True)
        with self.assertRaises(ValueError):
            guest.size_bound(tree)
        (tree / "temporary").unlink()
        guest.size_bound(tree)

    def test_network_check_requires_no_route_and_rejects_success_or_timeout(self):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        with patch.object(guest.socket, "socket", return_value=connection):
            connection.connect.side_effect = OSError(guest.errno.ENETUNREACH, "no route")
            guest.verify_offline_network()
            self.assertEqual(connection.connect.call_count, 21)
            connection.connect.side_effect = None
            with self.assertRaises(ValueError):
                guest.verify_offline_network()
            connection.connect.side_effect = TimeoutError("timeout is not namespace denial")
            with self.assertRaises(TimeoutError):
                guest.verify_offline_network()

    def test_duplicate_json_keys_and_path_collisions_refused(self):
        with self.assertRaises(ValueError):
            guest.strict_json('{"version":2,"version":1}')
        oid = b"a" * 40
        listing = b"".join(b"100644 blob " + oid + b" 0\t" + path + b"\0" for path in (b"a", b"a-b", b"a/b"))
        with self.assertRaises(ValueError):
            guest.source_entries(listing)

    def test_import_never_launches_requested_project_script(self):
        request = {**self.request, "launch": {"script": "dev"}}
        workspace = self.install(request=request)
        self.assertTrue(workspace.is_dir())
        self.assertFalse((workspace.parent / "receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
