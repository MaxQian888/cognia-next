"""Cognia Python plugin host.

Embedded into the Tauri binary via include_str! and written to
<app_data>/cognia/python/host.py at plugin_python_initialize. One host
process serves exactly one plugin.

Protocol (NDJSON over stdio, driven by src-tauri/src/plugin_api/python/):
  request   {"id": <int>, "method": <str>, "params": <object>}
  response  {"id": <int>, "ok": true, "result": <json>}
          | {"id": <int>, "ok": false, "error": <str>}

Methods: ping, import_main, get_tools, call_tool, call, get_info.

stdout is the protocol channel: plugin print() output is redirected to
stderr, which the Rust side forwards into the app log. Stdlib only.
"""

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
_MAIN_MODULE = None

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


def _install_cognia_shim():
    shim = types.ModuleType("cognia")
    shim.tool = _tool
    shim.hook = _hook
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


def _handle_import_main(params):
    global _MAIN_MODULE
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
    if plugin_path not in sys.path:
        sys.path.insert(0, plugin_path)
    _install_cognia_shim()
    _MAIN_MODULE = importlib.import_module(_module_name_from(main_module))
    return _info()


def _info():
    return {"tool_count": len(_TOOLS), "hook_count": len(_HOOKS)}


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
    return _ensure_serializable(result, f"tool '{name}'")


def _handle_call(params):
    _require_loaded()
    function_name = params["function_name"]
    if function_name.startswith("_"):
        raise RuntimeError(f"private function names are not callable: {function_name}")
    fn = getattr(_MAIN_MODULE, function_name, None)
    if fn is None or not callable(fn):
        raise RuntimeError(f"no module-level callable named '{function_name}'")
    result = fn(*(params.get("args") or []))
    return _ensure_serializable(result, f"function '{function_name}'")


_METHODS = {
    "ping": lambda params: "pong",
    "import_main": _handle_import_main,
    "get_tools": lambda params: [entry["definition"] for entry in _TOOLS.values()],
    "call_tool": _handle_call_tool,
    "call": _handle_call,
    "get_info": lambda params: _info(),
}


def _respond(payload):
    _RPC_OUT.write(json.dumps(payload) + "\n")
    _RPC_OUT.flush()


def main():
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
        try:
            result = handler(request.get("params") or {})
            _respond({"id": request_id, "ok": True, "result": result})
        except BaseException as exc:  # never let one call kill the host
            _respond(
                {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
            )


if __name__ == "__main__":
    main()
