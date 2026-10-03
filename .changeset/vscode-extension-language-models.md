---
"cognia-next": minor
---

VS Code extensions that use `vscode.lm` now talk to the model you configured in Cognia. `lm.selectChatModels` offers that model (vendor `cognia`), and its `sendRequest` streams the reply, honors cancellation, and throws VS Code's `LanguageModelError` (`NoPermissions`, `Blocked`, `NotFound`) when a request is refused. Requests need the `ai:chat` permission (asked for at install when an extension uses `vscode.lm`), go through the PII gate and the plugin rate limit, and never use a key or provider of the extension's own. `countTokens`, `onDidChangeChatModels` and `languageModelAccessInformation` work. Tools are not supported: models never call an extension's tools, and `lm.registerTool` and the model and MCP provider registrations are accepted but unused, which the extension's log says.
