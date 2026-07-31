# Cognia hybrid plugin template

This starter is emitted by:

```bash
cognia plugin new my-hybrid-plugin --kind hybrid
```

The host loads `frontend/index.js` from `plugin.json`'s `main` field and imports `backend/main.py` from `pythonMain`. The sample keeps the frontend build-free and registers one Python tool, `template_echo`.

## Validate and package

```bash
node --check frontend/index.js
python -m py_compile backend/main.py
cognia plugin lint
cognia plugin build
```

`cognia plugin build` is build-free for hybrid plugins: it validates `plugin.json`, then packages `plugin.json`, `frontend/index.js`, `backend/main.py`, optional `styles.css`, and any `bundle_include[]` files into `target/cognia/<id>-<version>.zip`.
