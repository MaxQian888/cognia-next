---
"cognia-next": patch
---

`cognia-agent config get` now resolves dotted keys (`agentBackends.pi-rpc.model`, `providers.deepseek.baseURL`, `statusBar.theme`) by walking nested config instead of only matching top-level keys, with secrets still redacted on the way down. `config set` gains routes for `providers.<id>.model` and `agentBackends.<preset>.model`, so every config path the CLI can write is also readable — previously `config get agentBackends.pi-rpc.model` answered `unknown key`.
