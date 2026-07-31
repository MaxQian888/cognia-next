---
"cognia-next": patch
---

Stop injecting Codex credentials into spawned agents unless you explicitly adopted an account. When no Codex account was active, cognia read `~/.codex/auth.json` on every agent spawn and injected whatever it found — on by default, and contrary to how the feature was already documented. For a codex-cli pointed at a third-party relay, that could override the API key the CLI authenticates with and break a working login nobody asked us to touch. With no adopted account, cognia now injects nothing and Codex inherits its own configuration exactly as it would on the command line. Adopting a credential through Settings → Subscription → Codex ("Reuse") is unchanged.

The now-meaningless "Reuse codex-cli when our vault is empty" toggle is removed; existing settings keep the value harmlessly and nothing reads it.
