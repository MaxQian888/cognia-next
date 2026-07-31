---
"cognia-next": minor
---

TUI: stop sending the built-in provider's model to a hosted external agent, and give Codex a real model picker.

`--backend codex` used to display the built-in provider's model (`codex · claude-opus-4-8`) **and** send that id to Codex's `thread/start`, which does not validate it. The model shown and dispatched now follows whichever backend is answering: an external agent gets only a model explicitly chosen for it, and otherwise none at all — so Codex keeps using its own `~/.codex/config.toml`. Per-backend picks are remembered separately from chat providers, so choosing a Claude Code model no longer rewrites the built-in Anthropic one.

`/model` on the native Codex app-server now lists Codex's own models and applies a pick to the live session without discarding the thread. Codex's v2 token-usage notification now supplies its authoritative live context count and model window to the footer and context panels, including post-5.4 models. Backends that cannot enumerate their models, and settings that cannot reach the hosting agent (`/thinking`, subagent models), now say so with a reason instead of silently doing nothing.

Provider changes no longer inject the selected chat provider's default model into a hosted external agent. External metadata resolution stays keyed to the launched backend, while built-in provider switching continues to restore each provider's remembered/default model.
