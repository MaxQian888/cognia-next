---
"cognia-next": minor
---

Pro IDE: wire the remote-host relay end to end, add the Native Extensions trust-domain switch, and close four dormant paths.

- Driving a paired remote host can now open Pro IDE. The desktop binds its pinned loopback relay, mints the device access token the companion front door requires, and re-mints it before the five-minute expiry so a session no longer dies mid-use. Fixes the relay mount path, which advertised and validated `/ide/v1/relay/...` while the companion serves `/ide/relay/...`.
- The engine switch now offers the Managed and Extensions (Open VSX) code-server profiles. The choice is persisted per scope alongside the editor engine, and theming, editor preferences and display language follow it instead of always writing the managed profile.
- Settings → Pro IDE can cancel an in-flight pre-fetch, matching the editor pane; a cancel now reads as a cancel rather than a failure.
- "Add to Chat" / Explain / Fix / Review from the embedded VS Code now routes to the composer, so the action works from the Agent Team workspace Editor tab instead of staging invisibly. Its prompts are translated.
- Detaching from a remote host stops the IDE instances started on it; nothing else could list or stop them afterwards.
- A crashed remote instance now surfaces its retry affordance instead of leaving a dead page pinned over the app.
