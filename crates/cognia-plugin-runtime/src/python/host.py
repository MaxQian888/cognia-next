"""Cognia Python plugin host.

Embedded into the Tauri binary via include_str! and written to
<app_data>/cognia/python/host.py at plugin_python_initialize. One host
process serves exactly one plugin.

Protocol (NDJSON over stdio, driven by src-tauri/src/plugin_api/python/):
  request   {"id": <int>, "method": <str>, "params": <object>}
  response  {"id": <int>, "ok": true, "result": <json>}
          | {"id": <int>, "ok": false, "error": <str>}
  event     {"type": "event", "event": <str>, "call_id"?: <int>, "data": <json>}
            (un-correlated notification: "progress" | "chunk" | "chunk_end";
             "log" and "exit" are synthesized Rust-side)

Methods: ping, import_main, get_tools, call_tool, call, call_hook,
push_config, get_info, shutdown.

The `cognia` shim installed into sys.modules before importing the plugin
exposes: tool, hook, progress, get_config, log, on_config_changed — mirroring
the reference SDK's module-level surface (plugin-sdk/python/src/cognia).

Lifecycle conventions (module-level, all optional): on_startup() runs after
import; on_config_updated(config) runs on push_config; on_shutdown() runs
on graceful shutdown. Tools returning an iterator/generator stream each
chunk as an event before the terminal reply.

stdout is the protocol channel: plugin print() output is redirected to
stderr, which the Rust side forwards into the app log. Stdlib only.
"""

import collections.abc
import importlib
import importlib.util
import inspect
import json
import re
import sys
import types

_RPC_OUT = sys.stdout
sys.stdout = sys.stderr  # plugin print() must never corrupt the protocol

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
_CURRENT_CALL_ID = None  # request id while a handler runs (serial main loop)
_SHUTDOWN = False

_TYPE_MAP = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


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


def _emit_event(event, data=None, call_id=None):
    """Write one un-correlated notification frame to the protocol channel."""
    payload = {"type": "event", "event": event, "data": data}
    if call_id is not None:
        payload["call_id"] = call_id
    _RPC_OUT.write(json.dumps(payload) + "\n")
    _RPC_OUT.flush()


def _progress(pct=None, message=None):
    """cognia.progress(...) — report progress for the in-flight call."""
    data = {}
    if pct is not None:
        data["pct"] = pct
    if message is not None:
        data["message"] = message
    _emit_event("progress", data, _CURRENT_CALL_ID)


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


def _handle_import_main(params):
    global _MAIN_MODULE, _CONFIG
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
    _CONFIG = dict(params.get("config") or {})
    if plugin_path not in sys.path:
        sys.path.insert(0, plugin_path)
    _install_cognia_shim()
    _MAIN_MODULE = importlib.import_module(_module_name_from(main_module))
    startup = _lifecycle_fn("on_startup")
    if startup is not None:
        startup()
    info = _info()
    info["hooks"] = [{"event": event, "name": fn.__name__} for event, fn in _HOOKS]
    info["contributions"] = [
        {"id": cid, "methods": sorted(methods.keys())} for cid, methods in _CONTRIBUTIONS.items()
    ]
    return info


def _info():
    return {
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


def _handle_call_tool(params):
    _require_loaded()
    name = params["name"]
    entry = _TOOLS.get(name)
    if entry is None:
        raise RuntimeError(f"unknown tool: {name}")
    result = entry["fn"](**(params.get("args") or {}))
    if isinstance(result, collections.abc.Iterator):
        # Streaming tool: each chunk goes out as an event frame before the
        # terminal reply (str is Iterable but not Iterator, so plain string
        # results never land here).
        chunks = []
        for chunk in result:
            _ensure_serializable(chunk, f"tool '{name}' stream chunk")
            _emit_event("chunk", chunk, _CURRENT_CALL_ID)
            chunks.append(chunk)
        _emit_event("chunk_end", None, _CURRENT_CALL_ID)
        if chunks and all(isinstance(c, str) for c in chunks):
            return "".join(chunks)
        return chunks
    return _ensure_serializable(result, f"tool '{name}'")


def _dispatch_contribution(args):
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
    result = fn(*(call_args or []))
    if stream_id is None or not isinstance(result, collections.abc.Iterator):
        return _ensure_serializable(result, label)

    chunks = []
    for chunk in result:
        _ensure_serializable(chunk, f"{label} stream chunk")
        _emit_event("chunk", {"streamId": stream_id, "value": chunk}, _CURRENT_CALL_ID)
        chunks.append(chunk)
    _emit_event("chunk_end", {"streamId": stream_id}, _CURRENT_CALL_ID)
    if chunks and all(isinstance(c, str) for c in chunks):
        return "".join(chunks)
    return chunks


def _handle_call(params):
    _require_loaded()
    function_name = params["function_name"]
    if function_name == CONTRIBUTION_DISPATCH:
        return _dispatch_contribution(params.get("args"))
    if function_name.startswith("_"):
        raise RuntimeError(f"private function names are not callable: {function_name}")
    fn = getattr(_MAIN_MODULE, function_name, None)
    if fn is None or not callable(fn):
        raise RuntimeError(f"no module-level callable named '{function_name}'")
    result = fn(*(params.get("args") or []))
    return _ensure_serializable(result, f"function '{function_name}'")


def _handle_call_hook(params):
    _require_loaded()
    event = params["event"]
    name = params["name"]
    for hook_event, fn in _HOOKS:
        if hook_event == event and fn.__name__ == name:
            result = fn(params.get("payload"))
            return _ensure_serializable(result, f"hook '{name}' for '{event}'")
    raise RuntimeError(f"no hook named '{name}' registered for event '{event}'")


def _handle_push_config(params):
    global _CONFIG
    _CONFIG = dict(params.get("config") or {})
    updated = _lifecycle_fn("on_config_updated")
    if updated is not None:
        updated(_CONFIG)
    # Notify cognia.on_config_changed subscribers. A listener that raises must
    # not stop the others or the host push.
    for listener in list(_CONFIG_LISTENERS):
        try:
            listener(_CONFIG)
        except Exception:
            pass
    return None


def _handle_shutdown(params):
    global _SHUTDOWN
    shutdown = _lifecycle_fn("on_shutdown")
    if shutdown is not None:
        shutdown()
    _SHUTDOWN = True
    return "bye"


import importlib

# Modules imported on demand via `ctx.python.import(name)`. Keyed by the
# fully-qualified module name so `module_call` / `module_getattr` resolve the
# same object the plugin imported.
_IMPORTED_MODULES = {}


def _eval_globals():
    # A fresh globals each call keeps eval/exec from leaking names between
    # invocations while still exposing the standard builtins (the plugin is
    # already trusted via the consented `python:execute` grant).
    return {"__builtins__": __builtins__, "modules": _IMPORTED_MODULES}


def _handle_eval(params):
    code = params.get("code")
    if not isinstance(code, str) or not code:
        raise RuntimeError("eval requires a non-empty 'code' string")
    locals_ = dict(params.get("locals") or {})
    g = _eval_globals()
    try:
        result = eval(compile(code, "<plugin-eval>", "eval"), g, locals_)
    except SyntaxError:
        # Not an expression — run as a statement block and return None.
        exec(compile(code, "<plugin-eval>", "exec"), g, locals_)
        result = None
    return _ensure_serializable(result, "eval")


def _resolve_module(module_name):
    if not isinstance(module_name, str) or not module_name:
        raise RuntimeError("a non-empty 'module_name' is required")
    mod = _IMPORTED_MODULES.get(module_name)
    if mod is None:
        mod = importlib.import_module(module_name)
        _IMPORTED_MODULES[module_name] = mod
    return mod


def _handle_import(params):
    _resolve_module(params.get("module_name"))
    return None


def _handle_module_call(params):
    mod = _resolve_module(params.get("module_name"))
    function_name = params.get("function_name")
    if not isinstance(function_name, str) or function_name.startswith("_"):
        raise RuntimeError(f"not a callable module attribute: {function_name!r}")
    fn = getattr(mod, function_name, None)
    if fn is None or not callable(fn):
        raise RuntimeError(
            f"no callable '{function_name}' on module '{params.get('module_name')}'"
        )
    result = fn(*(params.get("args") or []))
    return _ensure_serializable(result, f"module_call '{function_name}'")


def _handle_module_getattr(params):
    mod = _resolve_module(params.get("module_name"))
    attr_name = params.get("attr_name")
    if not isinstance(attr_name, str) or attr_name.startswith("_"):
        raise RuntimeError(f"not a readable module attribute: {attr_name!r}")
    value = getattr(mod, attr_name)
    return _ensure_serializable(value, f"module_getattr '{attr_name}'")


_METHODS = {
    "ping": lambda params: "pong",
    "import_main": _handle_import_main,
    "get_tools": lambda params: [entry["definition"] for entry in _TOOLS.values()],
    "call_tool": _handle_call_tool,
    "call": _handle_call,
    "call_hook": _handle_call_hook,
    "push_config": _handle_push_config,
    "get_info": lambda params: _info(),
    "shutdown": _handle_shutdown,
    "eval": _handle_eval,
    "import": _handle_import,
    "module_call": _handle_module_call,
    "module_getattr": _handle_module_getattr,
}


def _respond(payload):
    _RPC_OUT.write(json.dumps(payload) + "\n")
    _RPC_OUT.flush()


def main():
    global _CURRENT_CALL_ID
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request["id"]
        except (ValueError, KeyError, TypeError):
            print(f"host.py: dropping malformed request line: {line[:200]}", file=sys.stderr)
            continue
        method = request.get("method")
        handler = _METHODS.get(method)
        if handler is None:
            _respond({"id": request_id, "ok": False, "error": f"unknown method: {method}"})
            continue
        _CURRENT_CALL_ID = request_id
        try:
            result = handler(request.get("params") or {})
            _respond({"id": request_id, "ok": True, "result": result})
        except BaseException as exc:  # never let one call kill the host
            _respond(
                {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
            )
        finally:
            _CURRENT_CALL_ID = None
        if _SHUTDOWN:
            break  # graceful exit after the shutdown reply was flushed


if __name__ == "__main__":
    main()
