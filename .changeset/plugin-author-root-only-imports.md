---
"cognia-next": minor
---

`cognia plugin lint` and `cognia plugin build` now check a plugin's own source before esbuild runs and reject any `@/` alias, `@cognia/plugin-sdk/host`, a `@cognia/plugin-ui` subpath, or any other `@cognia/*` package. Previously such a plugin built cleanly and was refused at load time, or worse, had the host module inlined into its bundle where the loader's text scan could no longer see it. The load-time boundary now covers every `@/` directory rather than four of them.
