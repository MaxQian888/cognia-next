---
"cognia-next": patch
---

Connector settings now say which host can do what, instead of asserting you need the desktop app. A browser paired to a server is told its bots run on that host and that replying and per-conversation settings keep working there; a standalone browser is told there is no bot running anywhere. The tunnel panel stops advertising a tunnel to deployments that never run one, and OneBot's Verify and Probe buttons render disabled with the reason instead of disappearing. Connectors contributed by plugins can finally be added and configured — from the schema the plugin already declares, with secrets stored in the OS keyring.
