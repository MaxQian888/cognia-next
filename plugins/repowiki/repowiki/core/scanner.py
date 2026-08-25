"""scan a project directory and collect file metadata for analysis."""

from __future__ import annotations

import logging
import os
from fnmatch import fnmatch
from pathlib import Path

from repowiki.core.models import FileInfo

logger = logging.getLogger(__name__)

_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".idea", ".vscode", ".next", "dist", "build", ".tox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "egg-info", ".turbo", "coverage",
    ".cache", "vendor", "target", "__snapshots__", ".svn", ".hg",
    ".gradle", ".m2", "Pods", ".dart_tool", ".pub-cache",
}

_SKIP_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
    ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".pyc", ".pyo", ".class", ".o", ".obj",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".db", ".sqlite", ".sqlite3",
    ".lock",
    ".min.js", ".min.css",
    ".map",
    ".wasm",
}

_SENSITIVE_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "known_hosts",
}

_MINIFIED_SOURCE_EXTS = {".js", ".mjs", ".cjs", ".css"}

_LANG_MAP = {
    ".py": "python", ".pyi": "python",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".mts": "typescript",
    ".jsx": "jsx", ".tsx": "tsx",
    ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".json": "json", ".jsonc": "json",
    ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown", ".mdx": "markdown",
    ".txt": "text", ".rst": "rst",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin",
    ".scala": "scala",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".r": "r", ".R": "r",
    ".sql": "sql",
    ".swift": "swift",
    ".lua": "lua",
    ".dart": "dart",
    ".vue": "vue",
    ".svelte": "svelte",
    ".zig": "zig",
    ".nim": "nim",
    ".ex": "elixir", ".exs": "elixir",
    ".erl": "erlang",
    ".hs": "haskell",
    ".ml": "ocaml",
    ".clj": "clojure",
    ".proto": "protobuf",
    ".graphql": "graphql", ".gql": "graphql",
    ".tf": "terraform", ".hcl": "hcl",
    ".prisma": "prisma",
    ".astro": "astro",
    ".cfg": "ini", ".ini": "ini",
    ".env": "text",
    ".cmake": "cmake",
    ".gradle": "gradle",
    ".dockerfile": "dockerfile",
}

# files that give the LLM project context -- always read in full
_CONFIG_FILES = {
    "requirements.txt", "setup.py", "setup.cfg", "pyproject.toml",
    "package.json", "Cargo.toml", "go.mod", "go.sum",
    "Makefile", "CMakeLists.txt",
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    ".env.example", "config.py", "config.yaml", "config.json", "config.toml",
    "README.md", "README.rst", "README.txt", "README",
    "tsconfig.json", "vite.config.ts", "vite.config.js",
    "webpack.config.js", "rollup.config.js",
    "Gemfile", "build.gradle", "pom.xml",
    ".eslintrc.json", ".prettierrc",
}

# files that are likely entry points
_ENTRYPOINT_NAMES = {
    "main.py", "app.py", "index.py", "server.py", "run.py", "__main__.py",
    "main.go", "main.rs", "main.ts", "main.js",
    "index.ts", "index.js", "index.tsx", "index.jsx",
    "App.tsx", "App.jsx", "App.vue", "App.svelte",
    "manage.py", "wsgi.py", "asgi.py",
}

_ENTRYPOINT_DIRS = {"cmd", "bin", "scripts", "entrypoints"}


def _is_binary(data: bytes) -> bool:
    return b"\x00" in data[:1024]


def _has_skipped_suffix(path: Path) -> bool:
    name = path.name.lower()
    return any(name.endswith(ext) for ext in _SKIP_EXTS)


class IgnoreRules:
    def __init__(self, patterns: list[tuple[str, bool]]):
        self.patterns = patterns

    @classmethod
    def from_root(cls, root: Path) -> "IgnoreRules":
        patterns: list[tuple[str, bool]] = []
        for name in (".gitignore", ".repowikiignore"):
            path = root / name
            if not path.exists():
                continue
            for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                negated = line.startswith("!")
                if negated:
                    line = line[1:].strip()
                if line:
                    patterns.append((line.replace("\\", "/"), negated))
        return cls(patterns)

    def matches(self, rel_path: str, *, is_dir: bool = False) -> bool:
        rel_path = rel_path.replace("\\", "/").strip("/")
        ignored = False
        for pattern, negated in self.patterns:
            if _matches_ignore_pattern(pattern, rel_path, is_dir=is_dir):
                ignored = not negated
        return ignored


def _matches_ignore_pattern(pattern: str, rel_path: str, *, is_dir: bool) -> bool:
    dir_pattern = pattern.endswith("/")
    pattern = pattern.strip("/")
    if not pattern:
        return False
    if dir_pattern:
        return is_dir and (rel_path == pattern or rel_path.startswith(pattern + "/"))
    if "/" in pattern:
        return fnmatch(rel_path, pattern) or rel_path.startswith(pattern.rstrip("*") + "/")
    return any(fnmatch(part, pattern) for part in rel_path.split("/"))


def _is_sensitive_name(path: Path) -> bool:
    name = path.name.lower()
    if name in _SENSITIVE_NAMES:
        return True
    return name.startswith(".env.") and name != ".env.example"


def _looks_minified_source(path: str, text: str) -> bool:
    if Path(path).suffix.lower() not in _MINIFIED_SOURCE_EXTS:
        return False

    lines = text.splitlines() or [text]
    longest = max(len(line) for line in lines)
    if longest < 1000:
        return False

    non_empty = [line for line in lines if line.strip()]
    return len(non_empty) <= 5 or longest > len(text) * 0.5


def detect_language(path: str) -> str:
    name = Path(path).name.lower()
    if name == "dockerfile" or name.startswith("dockerfile."):
        return "dockerfile"
    if name == "makefile":
        return "makefile"
    ext = Path(path).suffix.lower()
    return _LANG_MAP.get(ext, "unknown")


def _is_entrypoint(rel_path: str) -> bool:
    parts = Path(rel_path).parts
    name = parts[-1]
    if name in _ENTRYPOINT_NAMES:
        return True
    if len(parts) >= 2 and parts[-2] in _ENTRYPOINT_DIRS:
        return True
    return False


def build_file_tree(files: list[FileInfo], max_lines: int = 200) -> str:
    """render an ascii tree from the file list, similar to `tree` command."""
    # collect unique directories + files
    entries: set[str] = set()
    for f in files:
        entries.add(f.path)
        parts = Path(f.path).parts
        for i in range(1, len(parts)):
            entries.add(str(Path(*parts[:i])) + "/")

    sorted_entries = sorted(entries)
    lines = []
    for entry in sorted_entries[:max_lines]:
        depth = entry.rstrip("/").count(os.sep)
        indent = "  " * depth
        name = Path(entry.rstrip("/")).name
        if entry.endswith("/"):
            name += "/"
        lines.append(f"{indent}{name}")

    if len(sorted_entries) > max_lines:
        lines.append(f"  ... and {len(sorted_entries) - max_lines} more entries")
    return "\n".join(lines)


def _walk_relative_paths(root: Path, ignore_rules: "IgnoreRules") -> list[str]:
    """Upstream's own enumeration: ``os.walk`` plus the ignore rules.

    Still here — and still the default — because the whole scanner suite runs
    against a temp directory with no host attached. When the plugin runs for
    real the host walks instead (see :func:`scan_directory`'s ``paths``), which
    adds gitignore semantics from the ``ignore`` crate and a refusal to hand
    over credential files at all.
    """
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        kept_dirs = []
        for dirname in dirnames:
            full_dir = Path(dirpath) / dirname
            rel_dir = full_dir.relative_to(root).as_posix()
            if dirname in _SKIP_DIRS or dirname.endswith(".egg-info"):
                continue
            if ignore_rules.matches(rel_dir, is_dir=True):
                continue
            kept_dirs.append(dirname)
        dirnames[:] = kept_dirs

        for fname in filenames:
            full = Path(dirpath) / fname
            found.append(full.relative_to(root).as_posix())
    return found


def _read_file_info(
    root: Path,
    rel_posix: str,
    *,
    max_file_size: int,
    preview_lines: int,
    ignore_rules: "IgnoreRules",
) -> FileInfo | None:
    """Apply every content-level filter and read one file, or skip it.

    The filters upstream owns stay upstream's: skipped directories and
    extensions, `.gitignore`, symlinks, size and emptiness, binary sniffing,
    minified-source heuristics. The sensitive-name check stays too even though
    the host refuses those files first — a defence that only exists on one side
    of a boundary stops existing the moment the other side is bypassed, and
    this function is also reachable with a caller-supplied path list.
    """
    full = root / rel_posix
    rel = str(Path(rel_posix))

    if ignore_rules.matches(rel_posix):
        return None
    if any(part in _SKIP_DIRS or part.endswith(".egg-info") for part in Path(rel_posix).parts[:-1]):
        return None
    if full.is_symlink():
        return None
    if _is_sensitive_name(full):
        return None
    if _has_skipped_suffix(full):
        return None

    try:
        size = full.stat().st_size
    except OSError:
        return None
    if size > max_file_size or size == 0:
        return None

    try:
        raw = full.read_bytes()
    except OSError:
        return None
    if _is_binary(raw):
        return None

    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        return None

    if _looks_minified_source(rel, text):
        return None

    lang = detect_language(rel)
    fname = full.name
    is_cfg = fname in _CONFIG_FILES
    is_entry = _is_entrypoint(rel)
    line_count = text.count("\n") + 1

    # config/entrypoint files get full content for better LLM context
    preview = text if (is_cfg or is_entry) else "\n".join(text.splitlines()[:preview_lines])

    return FileInfo(
        path=rel,
        size=size,
        language=lang,
        lines=line_count,
        preview=preview,
        content=text,
        is_config=is_cfg,
        is_entrypoint=is_entry,
    )


def scan_directory(
    root: str | Path,
    max_file_size: int = 200 * 1024,
    max_files: int = 1000,
    preview_lines: int = 80,
    paths: list[str] | None = None,
) -> list[FileInfo]:
    """Walk a project directory and return file info with previews.

    ``paths`` is the host's answer to "which files may this plugin read" — the
    repo-relative list from ``ctx.workspace.walk``. Passing it replaces the
    local ``os.walk`` for *enumeration* only; contents are still read from disk
    here, because the host has already ruled on the paths and re-fetching a
    thousand files over RPC would buy nothing but latency.
    """
    root = Path(root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Not a directory: {root}")

    ignore_rules = IgnoreRules.from_root(root)
    candidates = paths if paths is not None else _walk_relative_paths(root, ignore_rules)

    results: list[FileInfo] = []
    for rel_posix in candidates:
        if len(results) >= max_files:
            logger.info("Hit file cap (%d), stopping", max_files)
            break
        info = _read_file_info(
            root,
            rel_posix.replace("\\", "/"),
            max_file_size=max_file_size,
            preview_lines=preview_lines,
            ignore_rules=ignore_rules,
        )
        if info is not None:
            results.append(info)

    # sort: configs first, then entrypoints, then alphabetical
    def _sort_key(f: FileInfo) -> tuple:
        if f.is_config:
            return (0, f.path)
        if f.is_entrypoint:
            return (1, f.path)
        return (2, f.path)

    results.sort(key=_sort_key)
    return results
