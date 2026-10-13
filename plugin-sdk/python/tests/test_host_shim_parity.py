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


def test_embedded_host_nested_ipc_emits_the_same_wire_shape():
    import json
    import subprocess
    import sys

    host = next((parent / _HOST_REL for parent in Path(__file__).resolve().parents
                 if (parent / _HOST_REL).is_file()), None)
    if host is None:
        pytest.skip("repo host.py not reachable from the SDK directory")
    # Import the actual embedded host in an isolated interpreter: it redirects
    # stdout and owns process-global executors, which must not leak into pytest.
    script = r'''
import asyncio, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("library_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
seen = []
async def record(method, params):
    seen.append([method, params])
    return {"value": 3}
host._host_call = record
ctx = host._HostNamespace("events")
async def check():
    assert await ctx.ipc.call("math", "add", [1, 2]) == {"value": 3}
    await ctx.ipc.describeExposedMethods("math")
asyncio.run(check())
for key in ("__proto__", "constructor", "prototype"):
    try:
        getattr(ctx.ipc, key)
        raise AssertionError(key)
    except AttributeError:
        pass
host._RPC_OUT.write(json.dumps(seen))
host._STDIN_POOL.shutdown(wait=False)
host._WORK_POOL.shutdown(wait=False)
'''
    completed = subprocess.run([sys.executable, "-c", script, str(host)],
                               capture_output=True, text=True, check=True, timeout=10)
    assert json.loads(completed.stdout) == [
        ["events.ipc.call", {"args": ["math", "add", [1, 2]]}],
        ["events.ipc.describeExposedMethods", {"args": ["math"]}],
    ]


@pytest.mark.parametrize("handler_definition, expected", [
    ("", []),
    ("add = 42\n", []),
    ("def add(a, b):\n    raise AssertionError('must not execute during import')\n", ["add"]),
    ("async def add(a, b):\n    raise AssertionError('must not execute during import')\n", ["add"]),
])
def test_embedded_host_reports_only_actual_public_callables(
    tmp_path, handler_definition, expected
):
    import json
    import subprocess
    import sys

    host = next((parent / _HOST_REL for parent in Path(__file__).resolve().parents
                 if (parent / _HOST_REL).is_file()), None)
    if host is None:
        pytest.skip("repo host.py not reachable from the SDK directory")
    (tmp_path / "main.py").write_text(
        handler_definition + "\ndef _private():\n    pass\n", encoding="utf-8"
    )
    script = r'''
import asyncio, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("library_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
async def check():
    return await host._handle_import_main({"plugin_path": sys.argv[2], "main_module": "main.py"})
try:
    info = asyncio.run(check())
    host._RPC_OUT.write(json.dumps(info["callable_functions"]))
finally:
    host._STDIN_POOL.shutdown(wait=False)
    host._WORK_POOL.shutdown(wait=False)
'''
    completed = subprocess.run(
        [sys.executable, "-c", script, str(host), str(tmp_path)],
        capture_output=True, text=True, check=True, timeout=10,
    )
    assert json.loads(completed.stdout) == expected


def test_embedded_host_async_startup_completes_before_callable_discovery(tmp_path):
    import json
    import subprocess
    import sys

    host = next((parent / _HOST_REL for parent in Path(__file__).resolve().parents
                 if (parent / _HOST_REL).is_file()), None)
    if host is None:
        pytest.skip("repo host.py not reachable from the SDK directory")
    (tmp_path / "main.py").write_text('''
from cognia import ctx
async def on_startup():
    global add
    result = await ctx.events.ipc.call("math", "add", [1, 2])
    assert result == 3
    add = lambda a, b: a + b
''', encoding="utf-8")
    script = r'''
import asyncio, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("library_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
seen = []
async def record(method, params):
    seen.append([method, params])
    return 3
host._host_call = record
async def check():
    info = await host._handle_import_main({"plugin_path": sys.argv[2], "main_module": "main.py"})
    result = await host._handle_call({"function_name": "add", "args": [2, 3]})
    return {"functions": info["callable_functions"], "result": result, "seen": seen}
try:
    host._RPC_OUT.write(json.dumps(asyncio.run(check())))
finally:
    host._STDIN_POOL.shutdown(wait=False)
    host._WORK_POOL.shutdown(wait=False)
'''
    completed = subprocess.run(
        [sys.executable, "-c", script, str(host), str(tmp_path)],
        capture_output=True, text=True, check=True, timeout=10,
    )
    assert json.loads(completed.stdout) == {
        "functions": ["add", "on_startup"],
        "result": 5,
        "seen": [["events.ipc.call", {"args": ["math", "add", [1, 2]]}]],
    }
