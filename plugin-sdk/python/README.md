# `@cognia/plugin-sdk` (Python)

Author-facing Python SDK for Cognia plugins: a standalone reference
implementation of the protocol the desktop app's Python host
(`crates/cognia-plugin-runtime/src/python/host.py`) speaks over NDJSON stdio,
plus typed helpers for writing manifests. Use it to type-check, run and test a
plugin without the app.

**Under the app, a plugin does not get this package.** Before importing the
plugin's `pythonMain`, the host installs its own small `cognia` module, so only
the names below exist at run time. A plugin that imports anything else from
`cognia` (a `define_*` helper, `PluginHook`, `Plugin`, a `*Def` dataclass) runs
here and fails with an `ImportError` in the app.

| Available under the host          | What it is                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tool`, `hook`                    | Register a tool or a hook handler (hook names are plain strings, e.g. `"onCommand"`)           |
| `progress`, `log`                 | Report progress (`pct` is 0-100) and log a line                                                |
| `get_config`, `on_config_changed` | The user's `configSchema` values, and a listener for changes                                   |
| `contribution`, `emit`            | Python-backed contributions and their event channel                                            |
| `ctx`                             | The `ctx.*` host APIs open to Python (each call is a coroutine; `ctx.run_sync` from sync code) |
| `HostCallError`                   | What a failed `ctx` call raises                                                                |

Everything else here is for **authoring and tests**: build manifest entries in
a script and paste or write the JSON into `plugin.json`, validate what the
plugin publishes, or drive the plugin offline with `Runtime`. The SDK's
`tool`, `hook`, `progress`, `log`, `get_config`, `on_config_changed`,
`contribution`, `emit` and `ctx` behave like the host's, which is what makes
offline tests meaningful.

Stdlib only; targets Python ≥ 3.9.

Most authoring helpers are re-exported from the package root, including the
typed manifest entry mirrors. Import from `cognia.types` when you want the
module namespace, or from `cognia` for brevity, in build scripts and tests.

## Layout

| Module                       | Surface                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cognia.decorators`          | `@tool`, `@hook`                                                                                                                                                                                  |
| `cognia.runtime`             | `Runtime` (registry + protocol dispatch), `progress`, `get_config`, `log`                                                                                                                         |
| `cognia.context`             | `Context` — typed proxy over config / progress / logging                                                                                                                                          |
| `cognia.plugin`              | `Plugin` base class for class-style plugins                                                                                                                                                       |
| `cognia.types`               | `ToolDefinition`, `ToolParameter`, `PluginHook`, parameter inference, serialization checks, typed manifest entry mirrors (`WorkspaceBackendDef`, `MessageRendererDef`, `ChatMiddlewareDef`, etc.) |
| `cognia.modes`               | `Mode`, `define_mode`                                                                                                                                                                             |
| `cognia.a2ui`                | `A2UIComponent`, `define_component`, `define_template`                                                                                                                                            |
| `cognia.capability_contract` | `CapabilityContract`, `validate_capabilities`                                                                                                                                                     |
| `cognia.external_agent`      | `define_external_agent_preset`, `register_external_agent_preset`, `define_external_agent_adapter`, `register_external_agent_adapter`, `STDIO`, `ACP`                                              |
| `cognia.agent`               | `define_skill`, `define_subagent`, `define_command`, `define_quick_action`, `define_mcp_server_preset`, `define_native_anthropic_tool`, `define_agent_team_template`, `define_character_pack`     |
| `cognia.providers`           | `define_ai_provider`, `define_ocr_provider`, `define_lsp_server`, `define_cli_tool`, `define_connector`                                                                                           |
| `cognia.workflow`            | `define_workflow_template`, `define_scheduled_task`, `define_configuration`                                                                                                                       |
| `cognia.appearance`          | `define_theme`, `define_theme_pack`, `define_font_contribution`, `define_wallpaper`                                                                                                               |
| `cognia.pet`                 | `define_pet_item`, `define_pet_achievement`                                                                                                                                                       |
| `cognia.glance`              | `define_glance_module`, `glance_modules_manifest`, `validate_glance_data` (authoring + tests; publish with `ctx.glance.update`)                                                                   |

## Module-style plugin

What ships as `pythonMain` uses only the run-time names:

```python
from cognia import tool, hook, get_config, progress

@tool(description="Greet someone using the configured greeting.")
def greet(name: str):
    return f"{get_config().get('greeting', 'Hello')}, {name}!"

@tool(description="Stream a countdown.")
def countdown(start: int = 3):
    for i in range(start, 0, -1):
        progress(pct=round((start - i + 1) / start * 100))
        yield f"{i}... "
    yield "liftoff!"

@hook("onCommand")
async def on_command(invocation):
    if invocation.get("command") != "greet":
        return {"handled": False}
    return {"handled": True, "message": greet("world")}
```

## Authoring helpers

Manifest entries are built in a script (or a test), never imported by the
plugin itself:

```python
# scripts/manifest_entries.py — run with the SDK installed, not by the host
import json
from cognia import ToolRouteDef, WorkspaceBackendDef, define_glance_module

entries = {
    "workspaceBackends": [
        WorkspaceBackendDef(id="e2b", label="E2B", entry="workspace.py", export="create_backend").to_dict()
    ],
    "toolRoutes": [ToolRouteDef(tool_name="greet", utterances=["say hello", "greet user"]).to_dict()],
    "glanceModules": [define_glance_module("status", "Status", icon="Activity").to_dict()],
}
print(json.dumps(entries, indent=2))
```

## Class-style plugin

`Plugin` runs on the SDK's `Runtime` only: the app's host does not provide it,
so ship module-style code. Class style suits tools you exercise offline.

```python
from cognia import Plugin

class Greeter(Plugin):
    name = "greeter"

    @Plugin.tool(description="Greet someone.")
    def greet(self, who: str):
        return f"{self.context.config.get('greeting', 'Hello')}, {who}!"
```

## Python-backed contributions

`@cognia.contribution("<id>")` owns a module-bridge contribution (OCR provider,
AI provider, connector, external-agent adapter, …) whose behaviour runs in
Python; the renderer reaches it through `__cognia_dispatch_contribution__`.

```python
import cognia

@cognia.contribution("my-agent")
class MyAgent:
    def __init__(self):
        self.process = None  # per-instance state

    def connect(self, config): ...
    def disconnect(self): ...
```

Decorate a **class** whenever the contribution keeps state. The host may
address a contribution per instance (each external-agent configuration is one
instance), and a class gives every instance its own object, built on the
instance's first call and dropped when the host releases it. A decorated
**object** is shared, so it serves one instance at a time and the host refuses
a second. Calls that carry no instance id use the object built at decoration
time. `Runtime.dispatch_contribution(id, method, args, instance_id=...)` and
`Runtime.release_contribution_instance(id, instance_id)` drive the same rules
offline in tests.

## Running tests

From this directory:

```bash
python -m pytest
```

or from the repo root:

```bash
pnpm run sdk:python:test
```
