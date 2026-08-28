---
"cognia-next": minor
---

Make inline completion and AI suggestions work without a pasted API key

The composer's model-backed suggestions were built on `buildRendererLlmClient`, which needs an API
key the renderer can read. A Claude subscription keeps its bearer in the keyring and hands it to the
sidecar, never to the renderer — so on the app's primary auth mode, switching on "Inline
autocomplete" did nothing at all, and AI starter / follow-up suggestions were silently inert. The
same was true in the CLI TUI, and for every external agent (codex, opencode, gemini-cli, …), none of
which resolve a renderer-side key either.

- **A new agent tier for inline completion.** Press `Alt+\` in either composer to have the session's
  own agent write the continuation. It runs one bounded, tool-less turn through the same resolver
  the chat uses, so it works for whatever provider or external agent the session is bound to, with
  no per-agent adapter. Its suggestions merge into the existing ranked list — labelled `agent`, and
  ranked above a debounced one, because you asked for it deliberately.
- **Explicit, not automatic.** The tier never runs on a keystroke: one agent turn per typing burst
  is the wrong cost shape. Users with an API key saved keep the cheap debounced completion exactly
  as before and gain the key as a "try harder" option.
- **Tab accepts in the CLI too.** The TUI composer accepted a suggestion with `→` only, while the
  desktop used `Tab`. Both now accept either, so the two surfaces are muscle-memory compatible.
- **Starter / follow-up suggestions can use it too**, behind the new opt-in
  `composerAssistance.suggestions.agentFallback` (Settings → Conversation). It is off by default on
  purpose: follow-ups fire after every assistant reply, so turning it on is a real cost change
  rather than a repair.

New settings: `composerAssistance.suggestions.agentFallback` (desktop) and `autosuggest.agent`
(CLI). Both default off.
