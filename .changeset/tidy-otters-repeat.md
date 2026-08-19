---
"cognia-next": patch
---

Fix PostHog and OpenTelemetry telemetry never leaving the desktop app: product-analytics events now use PostHog's batch capture API over the native request path (the embedded browser SDK's own connections were blocked by the desktop CSP), a settings re-apply no longer silently disables a destination that was left enabled, and AI-observability spans from the app now carry the same PostHog identity the sidecar already sends.
