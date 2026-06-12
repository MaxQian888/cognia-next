# `@cognia/plugin-sdk` (Python)

Author-facing Python SDK for Cognia plugins. It is the standalone reference
implementation of the contract the embedded Tauri Python host
(`src-tauri/src/plugin_api/python/host.py`) speaks over its NDJSON stdio
protocol — so a plugin written against this SDK behaves identically whether it
runs under the host or directly with `python`.

Stdlib only; targets Python ≥ 3.9.

## Layout

| Module                               | Surface                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `cognia.decorators`                  | `@tool`, `@hook`                                                          |
| `cognia.runtime`                     | `Runtime` (registry + protocol dispatch), `progress`, `get_config`, `log` |
| `cognia.context`                     | `Context` — typed proxy over config / progress / logging                  |
| `cognia.plugin`                      | `Plugin` base class for class-style plugins                               |
| `cognia.types`                       | `ToolDefinition`, `ToolParameter`, parameter inference                    |
| `cognia.modes`                       | `Mode`, `define_mode`                                                     |
| `cognia.a2ui`                        | `A2UIComponent`, `define_component`, `define_template`                    |
| `cognia.capability_contract`         | `CapabilityContract`, `validate_capabilities`                             |
| `cognia_next.external_agent_presets` | `define_external_agent_preset`, `register_external_agent_preset`          |

## Module-style plugin

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

@hook("onMessageSend")
def stamp(payload):
    return payload
```

## Class-style plugin

```python
from cognia import Plugin

class Greeter(Plugin):
    name = "greeter"

    @Plugin.tool(description="Greet someone.")
    def greet(self, who: str):
        return f"{self.context.config.get('greeting', 'Hello')}, {who}!"
```

## Running tests

From this directory:

```bash
python -m pytest
```

or from the repo root:

```bash
pnpm run sdk:python:test
```
