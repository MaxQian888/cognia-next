# Cognia Python plugin template

This starter is emitted by:

```bash
cognia plugin new my-python-plugin --kind python
```

The host loads `main.py` from `plugin.json`'s `pythonMain` field and injects the `cognia` module before import.

The sample covers what a Python plugin can actually reach:

| Surface            | How                                                                           |
| ------------------ | ----------------------------------------------------------------------------- |
| Lifecycle          | module-level `on_startup` / `on_config_updated` / `on_shutdown`, all optional |
| Agent tools        | `@tool`, both a pure one and one that calls the host                          |
| Host calls         | `cognia.ctx.<namespace>.<method>()`, always a coroutine, so `async def`       |
| Settings           | `get_config()`, answering from `configSchema` in `plugin.json`                |
| Progress           | `progress(pct, message)` for a slow call — `pct` is 0-100, not a fraction     |
| A context panel    | `contextPanels[]` with `kind: "a2ui"` plus `ctx.a2ui`                         |
| Clicks coming back | `@hook("onA2UIAction")`                                                       |
| Typing coming back | `@hook("onA2UIDataChange")`, since a click carries no form values             |

Two constraints worth knowing before you extend it. `ctx` only exposes the
namespaces the contract opens to Python, and a method that would hand the host
a callback is refused by name, because a function does not survive the NDJSON
wire in either direction. Register those through the manifest instead, which is
what the context panel above does.

## Validate and package

```bash
python -m py_compile main.py
cognia plugin lint
cognia plugin build
```

`cognia plugin build` is build-free for Python plugins: it validates `plugin.json`, then packages `plugin.json`, `main.py`, and any `bundle_include[]` files into `target/cognia/<id>-<version>.zip`.

For local unit tests or type checking outside the desktop host, install or add the repository's `plugin-sdk/python` package to `PYTHONPATH`.
