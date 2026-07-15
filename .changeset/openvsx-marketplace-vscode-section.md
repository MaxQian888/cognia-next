---
"cognia-next": minor
---

Install VS Code extensions from Open VSX, in-app. The plugin marketplace gains a "VS Code" section that searches the Open VSX registry, resolves the right build for your machine, and installs through the normal consent flow — conflicts, permissions, bundled binaries, and configuration — with permissions inferred from the extension's real code rather than from anything the extension declares about itself. Dependencies (`extensionDependencies`) install as one all-or-nothing set; extension packs are offered separately instead of being installed behind your back. "Check for updates" now routes VS Code extensions to Open VSX instead of sending their ids to cognia's plugin registry, which previously leaked what you had installed and could never return a result.

What we verify, and what we don't — the UI says the same thing:

- **Downloads are checked against a SHA-256 checksum only.** That proves the file wasn't corrupted in transit, and nothing more: the checksum comes from the same server as the extension, so it cannot detect a compromised registry, a registry insider, or a publisher who simply ships something malicious. No PKCS#7 signature verification is performed and `.sigzip` is not validated, so extensions are never labelled "signature verified".
- **Open VSX's "verified publisher" flag is shown attributed to Open VSX**, because it is Open VSX's claim that a publisher owns a namespace — not our claim, and not a statement that the extension is safe.
- **Extensions run with real filesystem, network, and process access**, like any program you install. The install dialog says so next to the permission list.
- **Extensions using APIs cognia doesn't implement** (`vscode.debug`, `notebooks`, `scm`, `comments`, `tests`) are flagged at install and on the extension card, rather than blocked. The detection reads the extension's bundle and is best-effort: a minified extension can hide its API use, so it is a hint, not a guarantee. A mismatched `engines.vscode` range warns but never blocks — the range says nothing about which APIs an extension actually calls.
- **Microsoft's marketplace is out of scope.** Its terms of use limit it to Microsoft products, which is why VS Codium and code-server also use Open VSX.
- **Desktop only.** Installing requires the Cognia desktop app, since the download runs in the Rust backend to honour your proxy settings and verify checksums.
