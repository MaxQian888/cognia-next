---
"cognia-next": patch
---

Fix Agent Team runs failing whenever the lead had to propose a plan. Lead planning called the executor with no provider inputs, and the executor reads no settings store, so provider resolution had nothing to choose from and failed with "No candidate providers were available." on every run, in every environment, no matter what providers were configured. This hit any team whose plan-approval gate opened — including runs where the gate was raised automatically by the risk assessment rather than by the operator.

The lead now runs on an explicitly resolved provider and model: a provider/model set on the lead member wins, otherwise the application defaults apply. When no provider is configured at all, the run fails with a message that says so and points at Settings → Providers, instead of the resolver's bare internal reason. A lead-planning failure now fails the run with a visible reason rather than escaping as an unhandled error.
