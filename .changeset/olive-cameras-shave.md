---
"cognia-next": patch
---

Wire PostHog product analytics into the headless brain (`cognia-agent serve`), which previously could only export behavior events to OTLP. Configure it with `COGNIA_POSTHOG_HOST` / `COGNIA_POSTHOG_PROJECT_TOKEN` plus a pinned `COGNIA_OBSERVABILITY_INSTALLATION_ID`; the brain refuses to send without a stable id rather than reporting a new person on every restart. Because the brain has no per-destination consent UI, its PostHog destination is gated on the account's "Export remotely" consent — setting the environment variables configures a destination, it does not grant permission to use one.
