---
"cognia-next": minor
---

Rework the external-agent surfaces for density and navigability. The settings tab
becomes a fixed two-pane layout with a navigation rail (global settings,
delegation rules, quick start, agent roster) and an independently scrolling
detail pane — selecting an agent is no longer a one-way door, agents can be
connected straight from the list, and per-agent Edit/Delete moved up beside the
connect action. The agent editor groups its long form into collapsible sections
(connection / protocol options / timeout & retry), pairs protocol with transport,
adds a folder picker for the working directory, and finally exposes the Codex
app-server protocol in the manual picker. The chat-side manager compacts each
agent card to a single row, caps the roster height so diagnostics and sessions
stay reachable, and replaces the native `window.confirm` removal prompt with the
app's own confirmation dialog. The mobile page puts each agent's permission mode
beside its enable switch, one row per agent.
