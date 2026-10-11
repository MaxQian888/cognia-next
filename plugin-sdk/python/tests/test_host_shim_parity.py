"""Parity: every name the desktop host's ``cognia`` module offers exists here.

Under the app, a plugin's ``import cognia`` gets the host's shim
(``crates/cognia-plugin-runtime/src/python/host.py``, ``_install_cognia_shim``),
not this package. So the shim's names are the whole run-time surface, and each
must also exist on this package's root with the same role, or a plugin that runs
under the app fails its offline tests (``HostCallError`` was missing until this
test). Skips when the repo host file is not reachable (standalone SDK checkout).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import cognia

_HOST_REL = Path("crates/cognia-plugin-runtime/src/python/host.py")


def _shim_names() -> list[str]:
    for parent in Path(__file__).resolve().parents:
        host = parent / _HOST_REL
        if host.is_file():
            source = host.read_text(encoding="utf-8")
            body = source[source.index("def _install_cognia_shim") :]
            body = body[: body.index('sys.modules["cognia"]')]
            return re.findall(r"^\s+shim\.(\w+)\s*=", body, flags=re.M)
    pytest.skip("repo host.py not reachable from the SDK directory")


def test_every_host_shim_name_exists_on_the_sdk_root():
    names = _shim_names()
    assert {"tool", "hook", "ctx", "HostCallError"} <= set(names), names
    missing = [name for name in names if not hasattr(cognia, name)]
    assert missing == [], f"the host offers {missing}, which the SDK root lacks"


def test_host_call_error_is_the_one_ctx_raises_offline(fresh_runtime):
    import asyncio

    with pytest.raises(cognia.HostCallError):
        asyncio.run(cognia.ctx.logger.info("no host attached"))
