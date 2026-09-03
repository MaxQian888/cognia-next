---
"cognia-next": patch
---

Fix the defects a review of the sidebar peek and the external-agent runtime work turned up.

- Collapsing or expanding the rail no longer throws the conversation list away. The peek frame used to return two differently shaped trees, so React unmounted the whole list on every toggle and took the typed search query, the scroll offset and every live query with it.
- The sidebar account card tells the truth at rest. It read the cloud binding only once the menu had been opened, so a signed-in profile sat there labelled "On this device" until someone clicked it. A session that is merely offline or needs a fresh sign-in is no longer reported as a local-only profile, and only the ones a sign-in can actually fix offer that row.
- Theme-pack previews load from the plugin's own assets or not at all. A pack could point `preview` at any URL, and opening Settings → Appearance fetched it, which made browsing installed themes a beacon to whoever authored one.
- The rail's resting search control sits beside the buttons next to it instead of holding the row's whole width open around a magnifier glyph.
- The phone's edge swipe stands down while a sheet or dialog owns the screen, and an outward swipe no longer answers for a drawer that was never open.
- An external agent's published thinking ladder is read from the cache the composer already fills rather than over a fresh RPC on every turn, and a level folded down onto what the agent honours now says so in the log.
- A transport that is blocked because the paired Host has finished saying it cannot start agent processes is once again a settled verdict, so the runtime chip can fall back instead of retrying forever. The pre-handshake frames that the previous fix was aimed at stay transient.
- The filter drawer opens on the narrowing controls again on installs where that family collapses to a single section.
