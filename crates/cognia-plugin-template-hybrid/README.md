# Cognia hybrid plugin template

This starter is emitted by:

```bash
cognia plugin new my-hybrid-plugin --kind hybrid
```

The host loads `frontend/index.js` from `plugin.json`'s `main` field and imports `backend/main.py` from `pythonMain`. The sample keeps the frontend build-free.

A hybrid plugin is two runtimes under one manifest, and the sample shows both
directions across the seam:

| Piece                        | Runtime    | What it shows                                                        |
| ---------------------------- | ---------- | -------------------------------------------------------------------- |
| `template_echo`              | Python     | `@tool`, registered with the agent directly                          |
| `word_count`                 | Python     | a plain module-level function, no decorator needed                   |
| `template_word_count`        | JavaScript | a tool registered in JS whose work happens in Python                 |
| `/template-wordcount`        | JavaScript | a slash command answered with markdown                               |
| `ctx.python.call(name, ...)` | JavaScript | the bridge, present for `hybrid` and `python`, absent for `frontend` |

`ctx.python.call` resolves a **public, module-level** callable in `pythonMain`.
A name starting with an underscore is refused, and a nested or imported
function is not reachable at all.

## Validate and package

```bash
node --check frontend/index.js
python -m py_compile backend/main.py
cognia plugin lint
cognia plugin build
```

`cognia plugin build` is build-free for hybrid plugins: it validates `plugin.json`, then packages `plugin.json`, `frontend/index.js`, `backend/main.py`, optional `styles.css`, and any `bundle_include[]` files into `target/cognia/<id>-<version>.zip`.
