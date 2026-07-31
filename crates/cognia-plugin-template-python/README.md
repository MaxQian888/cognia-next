# Cognia Python plugin template

This starter is emitted by:

```bash
cognia plugin new my-python-plugin --kind python
```

The host loads `main.py` from `plugin.json`'s `pythonMain` field and injects the `cognia` module before import. The sample registers one Python tool, `template_echo`.

## Validate and package

```bash
python -m py_compile main.py
cognia plugin lint
cognia plugin build
```

`cognia plugin build` is build-free for Python plugins: it validates `plugin.json`, then packages `plugin.json`, `main.py`, and any `bundle_include[]` files into `target/cognia/<id>-<version>.zip`.

For local unit tests or type checking outside the desktop host, install or add the repository's `plugin-sdk/python` package to `PYTHONPATH`.
