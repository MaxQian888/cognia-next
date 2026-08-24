"""Cognia Python plugin host.

Embedded into the Tauri binary via include_str! and written to
<app_data>/cognia/python/host.py at plugin_python_initialize. One host
process serves exactly one plugin.

Protocol (NDJSON over stdio, driven by crates/cognia-plugin-runtime/src/python/):

  host -> plugin
    request        {"id": <int>, "method": <str>, "params": <object>}
    host_response  {"type": "host_response", "id": <int>, "ok": true, "result": <json>}
                 | {"type": "host_response", "id": <int>, "ok": false, "error": <str>}

  plugin -> host
    response       {"id": <int>, "ok": true, "result": <json>}
                 | {"id": <int>, "ok": false, "error": <str>}
    event          {"type": "event", "event": <str>, "call_id"?: <int>, "data": <json>}
                   (un-correlated notification: "progress" | "chunk" | "chunk_end" |
                    "emit"; "log" and "exit" are synthesized Rust-side)
    host_request   {"type": "host_request", "id": <int>, "method": <str>,
                    "params": <object>}

`host_request` is the plugin -> host RPC channel (ADR-0143): it lets a plugin
reach the host's `ctx.*` API surface (agent, storage, fs, git, ui, chat, ...).
Its `id` namespace is plugin-assigned and independent of the host-assigned
request ids -- the two travel in opposite directions and carry distinct `type`
tags, so they can never collide.

Methods: ping, import_main, get_tools, call_tool, call, call_hook,
push_config, get_info, shutdown, eval, import, module_call, module_getattr.

The `cognia` shim installed into sys.modules before importing the plugin
exposes: tool, hook, progress, get_config, log, on_config_changed,
contribution, emit, ctx -- mirroring the reference SDK's module-level surface
(plugin-sdk/python/src/cognia).

Concurrency: the main loop is asyncio. Inbound requests are served as
independent tasks, so a handler blocked on a `host_request` never stalls the
loop -- which is what makes `ctx.*` usable from inside a tool at all, and what
lets a plugin fan out concurrent host calls (RepoWiki's per-module analysis
runs five agent turns at once). Sync plugin code runs on a worker pool with
its contextvars copied across; async plugin code is awaited directly. stdin is
drained by its own single-thread executor so a saturated worker pool can never
starve the reader and deadlock the response path.

Lifecycle conventions (module-level, all optional): on_startup() runs after
import; on_config_updated(config) runs on push_config; on_shutdown() runs
on graceful shutdown. Tools returning an iterator/generator (sync or async)
stream each chunk as an event before the terminal reply.

stdout is the protocol channel: plugin print() output is redirected to
stderr, which the Rust side forwards into the app log. Stdlib only.
"""

import asyncio
import collections.abc
import contextvars
import functools
import importlib
import importlib.util
import inspect
import itertools
import json
import re
import sys
import threading
import types
from concurrent.futures import ThreadPoolExecutor

_RPC_OUT = sys.stdout
sys.stdout = sys.stderr  # plugin print() must never corrupt the protocol

#: Serializes protocol writes. Frames originate on the event loop *and* on
#: worker threads (a sync tool calling cognia.progress), so an unguarded
#: write can interleave two JSON lines into one unparseable frame.
_WRITE_LOCK = threading.Lock()

_TOOLS = {}  # name -> {"fn": callable, "definition": {name, description, parameters}}
_HOOKS = []  # (event, callable)
# contribution_id -> {method_name: callable}. Backs python-owned module-bridge
# contributions (ocr providers, ai providers, connectors, …) that the renderer
# reaches through `__cognia_dispatch_contribution__`. See
# `lib/plugin/bridge/_shared/python-backed-proxy.ts` for the host-side seam.
_CONTRIBUTIONS = {}

#: Reserved dispatcher name. The renderer calls it via the `call` RPC; it is
#: exempt from the private-name guard below because it is host-owned, not a
#: plugin symbol.
CONTRIBUTION_DISPATCH = "__cognia_dispatch_contribution__"
_MAIN_MODULE = None
_CONFIG = {}  # persisted plugin config, pushed by the host app
_CONFIG_LISTENERS = []  # cognia.on_config_changed(fn) subscribers, fired on push_config
#: Request id of the inbound call this task is serving. A ContextVar rather
#: than a global because the loop serves several requests concurrently, and
#: `progress` / `chunk` frames must stay correlated to the right one. Copied
#: into worker threads by `_to_worker`.
_CURRENT_CALL_ID = contextvars.ContextVar("cognia_current_call_id", default=None)
_SHUTDOWN = False

#: Set once the asyncio loop is running; worker threads reach the loop through
#: it to schedule host calls (`cognia.ctx.run_sync`).
_LOOP = None
#: Plugin-assigned ids for outbound `host_request` frames.
_HOST_CALL_IDS = itertools.count(1)
#: outbound id -> Future resolved by the matching `host_response` frame.
_HOST_PENDING = {}
#: Seconds a single `host_request` may stay unanswered. Overridable per plugin
#: through `import_main`'s `host_call_timeout_ms`.
_HOST_CALL_TIMEOUT = 120.0
#: Outbound host calls currently awaiting a response.
_INFLIGHT_HOST_CALLS = 0
#: Runaway-reentrancy backstop. A host call may legitimately cause the host to
#: call *back* into this plugin (ctx.agent.run resolving a tool this plugin
#: owns), and that is supported -- the loop keeps serving while blocked. What
#: is not supported is unbounded recursion, which grows this counter without
#: limit. The counter also rises with honest parallelism, so the default sits
#: well above any realistic fan-out; override via `import_main`.
_MAX_INFLIGHT_HOST_CALLS = 16

#: Dedicated single-thread reader. Sharing the worker pool would let saturated
#: tools starve stdin, and a stalled reader can never deliver the very
#: `host_response` those tools are blocked on.
_STDIN_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cognia-stdin")
#: Runs sync plugin code off the loop.
_WORK_POOL = ThreadPoolExecutor(max_workers=16, thread_name_prefix="cognia-work")

_TYPE_MAP = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


class HostCallError(RuntimeError):
    """A `ctx.*` call the host answered with `ok: false`."""


def _json_type_for(annotation):
    if annotation is inspect.Parameter.empty or annotation is None:
        return "any"
    # bool must be checked before int (bool subclasses int, but the map is
    # keyed by identity so plain lookup is safe; order matters only for
    # issubclass-style checks, which we avoid).
    if annotation in _TYPE_MAP:
        return _TYPE_MAP[annotation]
    origin = getattr(annotation, "__origin__", None)
    if origin in _TYPE_MAP:
        return _TYPE_MAP[origin]
    return "any"


def _infer_parameters(fn):
    """Build a PythonToolDef-shaped parameters dict from the signature."""
    try:
        hints = inspect.get_type_hints(fn)
    except Exception:
        hints = getattr(fn, "__annotations__", {}) or {}
    params = {}
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return params
    for param_name, param in signature.parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        entry = {"type": _json_type_for(hints.get(param_name, param.annotation))}
        if param.default is inspect.Parameter.empty:
            entry["required"] = True
        else:
            entry["required"] = False
            try:
                json.dumps(param.default)
                entry["default"] = param.default
            except (TypeError, ValueError):
                pass
        params[param_name] = entry
    return params


def _register_tool(fn, name=None, description="", parameters=None):
    tool_name = name or fn.__name__
    _TOOLS[tool_name] = {
        "fn": fn,
        "definition": {
            "name": tool_name,
            "description": description or (inspect.getdoc(fn) or ""),
            "parameters": parameters if parameters is not None else _infer_parameters(fn),
        },
    }
    return fn


def _tool(fn=None, *, name=None, description="", parameters=None):
    """@tool decorator — bare (@tool) or configured (@tool(name=..., ...))."""
    if fn is not None and callable(fn):
        return _register_tool(fn)

    def wrapper(inner):
        return _register_tool(inner, name=name, description=description, parameters=parameters)

    return wrapper


def _hook(event):
    """@hook(event) decorator — registers and counts; dispatch is TS-driven."""

    def wrapper(fn):
        _HOOKS.append((event, fn))
        return fn

    return wrapper


def _write_frame(payload):
    """Write one protocol frame. Safe from the loop and from worker threads."""
    line = json.dumps(payload) + "\n"
    with _WRITE_LOCK:
        _RPC_OUT.write(line)
        _RPC_OUT.flush()


def _emit_event(event, data=None, call_id=None):
    """Write one un-correlated notification frame to the protocol channel."""
    payload = {"type": "event", "event": event, "data": data}
    if call_id is None:
        call_id = _CURRENT_CALL_ID.get()
    if call_id is not None:
        payload["call_id"] = call_id
    _write_frame(payload)


def _progress(pct=None, message=None):
    """cognia.progress(...) — report progress for the in-flight call."""
    data = {}
    if pct is not None:
        data["pct"] = pct
    if message is not None:
        data["message"] = message
    _emit_event("progress", data)


def _get_config():
    """cognia.get_config() — the plugin's persisted config object."""
    return _CONFIG


def _log(*args):
    """cognia.log(...) — protocol-safe logging.

    Writes to stderr (the app-log channel) so it can never corrupt the NDJSON
    protocol on stdout. Mirrors the reference SDK's ``cognia.log``.
    """
    print(*args, file=sys.stderr)


def _on_config_changed(fn):
    """cognia.on_config_changed(fn) — register a listener fired whenever the
    host pushes new config. Mirrors the reference SDK's module-level proxy to
    ``Runtime.on_config_changed`` / the TS ``ctx.configuration.onChange``.
    """
    _CONFIG_LISTENERS.append(fn)
    return fn


def _contribution(contribution_id):
    """`@cognia.contribution("<id>")` — own a module-bridge contribution.

    Decorates a class (instantiated here) or an already-built object. Every
    public callable attribute becomes a method the renderer can invoke, so a
    python OCR provider is just::

        @cognia.contribution("tesseract")
        class Tesseract:
            def describe(self):
                return {"label": "Tesseract", "category": "local"}

            def extract(self, image, ctx):
                return {...}

    `describe()` supplies the plain-data fields a JS factory would have
    returned inline; the rest are behaviour.
    """
    if not isinstance(contribution_id, str) or not contribution_id:
        raise ValueError("cognia.contribution(id) requires a non-empty string id")

    def decorate(target):
        instance = target() if inspect.isclass(target) else target
        methods = {}
        for name in dir(instance):
            if name.startswith("_"):
                continue
            attr = getattr(instance, name, None)
            if callable(attr):
                methods[name] = attr
        if not methods:
            raise ValueError(f"contribution '{contribution_id}' exposes no public methods")
        _CONTRIBUTIONS[contribution_id] = methods
        return target

    return decorate


def _emit(contribution_id, channel, payload=None):
    """`cognia.emit(...)` — push an unsolicited frame to the host.

    The inbound half of a bidirectional contribution (connector messages,
    watcher events). Picked up by `subscribePythonContributionPush`.
    """
    _emit_event(
        "emit",
        {"contributionId": contribution_id, "channel": channel, "payload": payload},
    )


# ---------------------------------------------------------------------------
# plugin -> host RPC (`cognia.ctx.*`)
# ---------------------------------------------------------------------------


def _pack_params(args, kwargs):
    """Normalize a call site onto the wire's single `params` object.

    Three shapes, in precedence order: keywords become the object itself; a
    lone positional mapping is passed through (so a caller can build the
    object explicitly); anything else is wrapped as `{"args": [...]}`.
    """
    if kwargs and not args:
        return dict(kwargs)
    if len(args) == 1 and isinstance(args[0], dict) and not kwargs:
        return dict(args[0])
    params = {"args": list(args)} if args else {}
    params.update(kwargs)
    return params


async def _host_call(method, params=None):
    """Issue one `host_request` and await the host's answer."""
    global _INFLIGHT_HOST_CALLS
    loop = asyncio.get_running_loop()
    if _INFLIGHT_HOST_CALLS >= _MAX_INFLIGHT_HOST_CALLS:
        raise HostCallError(
            f"host call '{method}' refused: {_INFLIGHT_HOST_CALLS} calls already in "
            f"flight (limit {_MAX_INFLIGHT_HOST_CALLS}) — this usually means a host "
            "call is recursing back into this plugin without terminating"
        )
    call_id = next(_HOST_CALL_IDS)
    future = loop.create_future()
    _HOST_PENDING[call_id] = future
    _INFLIGHT_HOST_CALLS += 1
    try:
        _write_frame(
            {
                "type": "host_request",
                "id": call_id,
                "method": method,
                "params": params if params is not None else {},
            }
        )
        try:
            reply = await asyncio.wait_for(future, _HOST_CALL_TIMEOUT)
        except asyncio.TimeoutError:
            raise HostCallError(
                f"host call '{method}' timed out after {_HOST_CALL_TIMEOUT}s"
            ) from None
    finally:
        _INFLIGHT_HOST_CALLS -= 1
        _HOST_PENDING.pop(call_id, None)
    if not reply.get("ok"):
        raise HostCallError(reply.get("error") or f"host call '{method}' failed")
    return reply.get("result")


class _HostNamespace:
    """Attribute proxy for one `ctx.<namespace>`.

    Deliberately untyped: the host owns the method table, and pinning it here
    would mean a second copy to drift. The typed, documented surface lives in
    the SDK (`plugin-sdk/python/src/cognia/ctx/`), which calls straight through
    this proxy.
    """

    __slots__ = ("_namespace",)

    def __init__(self, namespace):
        self._namespace = namespace

    def __getattr__(self, method):
        if method.startswith("_"):
            raise AttributeError(method)
        namespace = self._namespace

        async def call(*args, **kwargs):
            return await _host_call(f"{namespace}.{method}", _pack_params(args, kwargs))

        call.__name__ = method
        call.__qualname__ = f"cognia.ctx.{namespace}.{method}"
        return call

    def __repr__(self):
        return f"<cognia.ctx.{self._namespace}>"


class _HostCtx:
    """`cognia.ctx` — the host's `ctx.*` API surface, reached over RPC."""

    def __getattr__(self, namespace):
        if namespace.startswith("_"):
            raise AttributeError(namespace)
        return _HostNamespace(namespace)

    async def call(self, method, params=None):
        """Escape hatch: invoke `<namespace>.<method>` by name."""
        return await _host_call(method, params)

    def run_sync(self, awaitable, timeout=None):
        """Block a worker thread on a `ctx.*` coroutine.

        For sync tools. Refuses to run on the event loop, where blocking would
        deadlock the very reader that has to deliver the response.
        """
        loop = _LOOP
        if loop is None:
            raise RuntimeError("cognia.ctx.run_sync() requires a running host loop")
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            raise RuntimeError(
                "cognia.ctx.run_sync() cannot be called from the event loop — "
                "await the coroutine instead"
            )
        return asyncio.run_coroutine_threadsafe(awaitable, loop).result(
            timeout if timeout is not None else _HOST_CALL_TIMEOUT
        )


_CTX = _HostCtx()


def _install_cognia_shim():
    shim = types.ModuleType("cognia")
    shim.tool = _tool
    shim.hook = _hook
    shim.progress = _progress
    shim.get_config = _get_config
    shim.log = _log
    shim.on_config_changed = _on_config_changed
    shim.contribution = _contribution
    shim.emit = _emit
    shim.ctx = _CTX
    shim.HostCallError = HostCallError
    sys.modules["cognia"] = shim


_DEP_NAME_SPLIT = re.compile(r"[<>=!~\[; ]")


def _check_dependencies(dependencies):
    """find_spec each declared pip dependency; return missing pip names."""
    missing = []
    for dep in dependencies or []:
        pip_name = _DEP_NAME_SPLIT.split(dep.strip(), 1)[0]
        if not pip_name:
            continue
        import_name = pip_name.replace("-", "_")
        try:
            spec = importlib.util.find_spec(import_name)
        except (ImportError, ValueError, ModuleNotFoundError):
            spec = None
        if spec is None:
            missing.append(pip_name)
    return missing


def _module_name_from(main_module):
    """manifest.pythonMain is file-like ("main.py", "src/entry.py") — convert
    to an importable dotted module name."""
    name = main_module.replace("\\", "/").strip("/")
    if name.endswith(".py"):
        name = name[: -len(".py")]
    return name.replace("/", ".")


def _lifecycle_fn(name):
    fn = getattr(_MAIN_MODULE, name, None) if _MAIN_MODULE is not None else None
    return fn if callable(fn) else None


async def _to_worker(fn, *args, **kwargs):
    """Run sync plugin code off the loop, carrying this task's contextvars.

    `run_in_executor` does not propagate context, so `_CURRENT_CALL_ID` would
    read as None inside the thread and every `progress` frame would lose its
    correlation.
    """
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()
    call = functools.partial(fn, *args, **kwargs)
    return await loop.run_in_executor(_WORK_POOL, lambda: ctx.run(call))


async def _invoke(fn, *args, **kwargs):
    """Call plugin code that may be sync or async, and resolve the result."""
    if inspect.iscoroutinefunction(fn):
        return await fn(*args, **kwargs)
    result = await _to_worker(fn, *args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


async def _handle_import_main(params):
    global _MAIN_MODULE, _CONFIG, _HOST_CALL_TIMEOUT, _MAX_INFLIGHT_HOST_CALLS
    plugin_path = params["plugin_path"]
    main_module = params["main_module"]
    missing = _check_dependencies(params.get("dependencies"))
    if missing:
        raise RuntimeError(
            "missing Python dependencies: "
            + ", ".join(missing)
            + " — install them with: pip install "
            + " ".join(missing)
        )
    timeout_ms = params.get("host_call_timeout_ms")
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        _HOST_CALL_TIMEOUT = float(timeout_ms) / 1000.0
    max_inflight = params.get("max_inflight_host_calls")
    if isinstance(max_inflight, int) and max_inflight > 0:
        _MAX_INFLIGHT_HOST_CALLS = max_inflight
    _CONFIG = dict(params.get("config") or {})
    if plugin_path not in sys.path:
        sys.path.insert(0, plugin_path)
    _install_cognia_shim()
    # Import off the loop: a plugin's module body is arbitrary blocking code,
    # and stalling the loop here would stall the stdin reader with it.
    _MAIN_MODULE = await _to_worker(importlib.import_module, _module_name_from(main_module))
    startup = _lifecycle_fn("on_startup")
    if startup is not None:
        await _invoke(startup)
    info = _info()
    info["hooks"] = [{"event": event, "name": fn.__name__} for event, fn in _HOOKS]
    info["contributions"] = [
        {"id": cid, "methods": sorted(methods.keys())} for cid, methods in _CONTRIBUTIONS.items()
    ]
    return info


def _info():
    return {
        "sdk_version": "__COGNIA_SDK_VERSION__",
        "protocol_version": "__COGNIA_PROTOCOL_VERSION__",
        "contract_version": "__COGNIA_CONTRACT_VERSION__",
        "runtime_id": "python",
        "capabilities": [
            "tools",
            "hooks",
            "contributions",
            "config",
            "events",
            "streaming",
            "host-calls",
            "async",
        ],
        "legacy_adapter": False,
        "tool_count": len(_TOOLS),
        "hook_count": len(_HOOKS),
        "contribution_count": len(_CONTRIBUTIONS),
    }


def _require_loaded():
    if _MAIN_MODULE is None:
        raise RuntimeError("plugin module not loaded — call import_main first")


def _ensure_serializable(value, context):
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        raise RuntimeError(
            f"{context} returned a non-JSON-serializable value of type "
            f"{type(value).__name__}"
        )
    return value


_SENTINEL = object()


def _next_or_sentinel(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return _SENTINEL


async def _drain(result, label, frame_for):
    """Stream a sync or async iterator, emitting one frame per item.

    Returns the collected chunks, joined when they are all strings — the same
    collapse the non-streaming reply path performs.
    """
    chunks = []
    if isinstance(result, collections.abc.AsyncIterator):
        async for chunk in result:
            _ensure_serializable(chunk, f"{label} stream chunk")
            _emit_event("chunk", frame_for(chunk))
            chunks.append(chunk)
    else:
        while True:
            chunk = await _to_worker(_next_or_sentinel, result)
            if chunk is _SENTINEL:
                break
            _ensure_serializable(chunk, f"{label} stream chunk")
            _emit_event("chunk", frame_for(chunk))
            chunks.append(chunk)
    if chunks and all(isinstance(c, str) for c in chunks):
        return "".join(chunks)
    return chunks


def _is_stream(value):
    return isinstance(
        value, (collections.abc.Iterator, collections.abc.AsyncIterator)
    )


async def _handle_call_tool(params):
    _require_loaded()
    name = params["name"]
    entry = _TOOLS.get(name)
    if entry is None:
        raise RuntimeError(f"unknown tool: {name}")
    result = await _invoke(entry["fn"], **(params.get("args") or {}))
    if _is_stream(result):
        # Streaming tool: each chunk goes out as an event frame before the
        # terminal reply (str is Iterable but not Iterator, so plain string
        # results never land here).
        collected = await _drain(result, f"tool '{name}'", lambda chunk: chunk)
        _emit_event("chunk_end", None)
        return collected
    return _ensure_serializable(result, f"tool '{name}'")


async def _dispatch_contribution(args):
    """Route `__cognia_dispatch_contribution__(id, method, args, streamId)`.

    Mirrors `createPythonBackedProxy` on the renderer side. When `stream_id` is
    present and the handler returns an iterator, each item goes out as a
    `chunk` frame tagged with that id (the protocol's own `call_id` never
    reaches the renderer, so the seam correlates on `streamId` instead) and the
    stream is closed with `chunk_end`.
    """
    _require_loaded()
    padded = list(args or []) + [None, None, None, None]
    contribution_id, method, call_args, stream_id = padded[:4]
    entry = _CONTRIBUTIONS.get(contribution_id)
    if entry is None:
        raise RuntimeError(f"unknown contribution: {contribution_id}")
    fn = entry.get(method)
    if fn is None or not callable(fn):
        raise RuntimeError(f"contribution '{contribution_id}' has no method '{method}'")

    label = f"contribution '{contribution_id}.{method}'"
    result = await _invoke(fn, *(call_args or []))
    if stream_id is None or not _is_stream(result):
        return _ensure_serializable(result, label)

    collected = await _drain(
        result, label, lambda chunk: {"streamId": stream_id, "value": chunk}
    )
    _emit_event("chunk_end", {"streamId": stream_id})
    return collected


async def _handle_call(params):
    _require_loaded()
    function_name = params["function_name"]
    if function_name == CONTRIBUTION_DISPATCH:
        return await _dispatch_contribution(params.get("args"))
    if function_name.startswith("_"):
        raise RuntimeError(f"private function names are not callable: {function_name}")
    fn = getattr(_MAIN_MODULE, function_name, None)
    if fn is None or not callable(fn):
        raise RuntimeError(f"no module-level callable named '{function_name}'")
    result = await _invoke(fn, *(params.get("args") or []))
    return _ensure_serializable(result, f"function '{function_name}'")


async def _handle_call_hook(params):
    _require_loaded()
    event = params["event"]
    name = params["name"]
    for hook_event, fn in _HOOKS:
        if hook_event == event and fn.__name__ == name:
            result = await _invoke(fn, params.get("payload"))
            return _ensure_serializable(result, f"hook '{name}' for '{event}'")
    raise RuntimeError(f"no hook named '{name}' registered for event '{event}'")


async def _handle_push_config(params):
    global _CONFIG
    _CONFIG = dict(params.get("config") or {})
    updated = _lifecycle_fn("on_config_updated")
    if updated is not None:
        await _invoke(updated, _CONFIG)
    # Notify cognia.on_config_changed subscribers. A listener that raises must
    # not stop the others or the host push.
    for listener in list(_CONFIG_LISTENERS):
        try:
            await _invoke(listener, _CONFIG)
        except Exception:
            pass
    return None


async def _handle_shutdown(params):
    global _SHUTDOWN
    shutdown = _lifecycle_fn("on_shutdown")
    if shutdown is not None:
        await _invoke(shutdown)
    _SHUTDOWN = True
    return "bye"


# Modules imported on demand via `ctx.python.import(name)`. Keyed by the
# fully-qualified module name so `module_call` / `module_getattr` resolve the
# same object the plugin imported.
_IMPORTED_MODULES = {}


def _eval_globals():
    # A fresh globals each call keeps eval/exec from leaking names between
    # invocations while still exposing the standard builtins (the plugin is
    # already trusted via the consented `python:execute` grant).
    return {"__builtins__": __builtins__, "modules": _IMPORTED_MODULES}


def _eval_sync(code, locals_):
    g = _eval_globals()
    try:
        return eval(compile(code, "<plugin-eval>", "eval"), g, locals_)
    except SyntaxError:
        # Not an expression — run as a statement block and return None.
        exec(compile(code, "<plugin-eval>", "exec"), g, locals_)
        return None


async def _handle_eval(params):
    code = params.get("code")
    if not isinstance(code, str) or not code:
        raise RuntimeError("eval requires a non-empty 'code' string")
    locals_ = dict(params.get("locals") or {})
    result = await _to_worker(_eval_sync, code, locals_)
    if inspect.isawaitable(result):
        result = await result
    return _ensure_serializable(result, "eval")


def _resolve_module(module_name):
    if not isinstance(module_name, str) or not module_name:
        raise RuntimeError("a non-empty 'module_name' is required")
    mod = _IMPORTED_MODULES.get(module_name)
    if mod is None:
        mod = importlib.import_module(module_name)
        _IMPORTED_MODULES[module_name] = mod
    return mod


async def _handle_import(params):
    await _to_worker(_resolve_module, params.get("module_name"))
    return None


async def _handle_module_call(params):
    mod = await _to_worker(_resolve_module, params.get("module_name"))
    function_name = params.get("function_name")
    if not isinstance(function_name, str) or function_name.startswith("_"):
        raise RuntimeError(f"not a callable module attribute: {function_name!r}")
    fn = getattr(mod, function_name, None)
    if fn is None or not callable(fn):
        raise RuntimeError(
            f"no callable '{function_name}' on module '{params.get('module_name')}'"
        )
    result = await _invoke(fn, *(params.get("args") or []))
    return _ensure_serializable(result, f"module_call '{function_name}'")


async def _handle_module_getattr(params):
    mod = await _to_worker(_resolve_module, params.get("module_name"))
    attr_name = params.get("attr_name")
    if not isinstance(attr_name, str) or attr_name.startswith("_"):
        raise RuntimeError(f"not a readable module attribute: {attr_name!r}")
    value = getattr(mod, attr_name)
    return _ensure_serializable(value, f"module_getattr '{attr_name}'")


async def _handle_ping(params):
    return "pong"


async def _handle_get_tools(params):
    return [entry["definition"] for entry in _TOOLS.values()]


async def _handle_get_info(params):
    return _info()


_METHODS = {
    "ping": _handle_ping,
    "import_main": _handle_import_main,
    "get_tools": _handle_get_tools,
    "call_tool": _handle_call_tool,
    "call": _handle_call,
    "call_hook": _handle_call_hook,
    "push_config": _handle_push_config,
    "get_info": _handle_get_info,
    "shutdown": _handle_shutdown,
    "eval": _handle_eval,
    "import": _handle_import,
    "module_call": _handle_module_call,
    "module_getattr": _handle_module_getattr,
}


def _respond(payload):
    _write_frame(payload)


def _classify_inbound(line):
    """Parse one stdin line into ("host_response" | "request", value).

    Returns None for anything unparseable. `host_response` is matched on its
    explicit `type` tag before the id check, mirroring `classify_frame` on the
    Rust side.
    """
    try:
        value = json.loads(line)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    if value.get("type") == "host_response":
        if isinstance(value.get("id"), int):
            return ("host_response", value)
        return None
    if isinstance(value.get("id"), int) and isinstance(value.get("method"), str):
        return ("request", value)
    return None


def _resolve_host_response(frame):
    future = _HOST_PENDING.get(frame["id"])
    if future is None or future.done():
        return  # timed out, cancelled, or a duplicate reply
    future.set_result(frame)


async def _serve(request):
    """Run one inbound request to completion and write its reply."""
    request_id = request["id"]
    method = request.get("method")
    handler = _METHODS.get(method)
    if handler is None:
        _respond({"id": request_id, "ok": False, "error": f"unknown method: {method}"})
        return
    token = _CURRENT_CALL_ID.set(request_id)
    try:
        result = await handler(request.get("params") or {})
        _respond({"id": request_id, "ok": True, "result": result})
    except BaseException as exc:  # never let one call kill the host
        _respond({"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    finally:
        _CURRENT_CALL_ID.reset(token)


async def _read_line(loop):
    """One blocking stdin read, moved to the dedicated reader thread."""
    return await loop.run_in_executor(_STDIN_POOL, sys.stdin.readline)


async def _main_async():
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    tasks = set()
    while True:
        raw = await _read_line(_LOOP)
        if raw == "":
            break  # EOF — host closed stdin
        line = raw.strip()
        if not line:
            continue
        classified = _classify_inbound(line)
        if classified is None:
            print(f"host.py: dropping malformed request line: {line[:200]}", file=sys.stderr)
            continue
        kind, frame = classified
        if kind == "host_response":
            _resolve_host_response(frame)
            continue
        task = asyncio.ensure_future(_serve(frame))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        if frame.get("method") == "shutdown":
            # Await this one inline so the "bye" reply is flushed before the
            # loop stops, then stop reading. Concurrency means _SHUTDOWN can
            # no longer be observed from here the way the serial loop did.
            await task
            break
    if tasks:
        # Let in-flight replies flush before the interpreter tears down.
        await asyncio.wait(tasks, timeout=5)


def main():
    try:
        asyncio.run(_main_async())
    finally:
        _STDIN_POOL.shutdown(wait=False)
        _WORK_POOL.shutdown(wait=False)


if __name__ == "__main__":
    main()
