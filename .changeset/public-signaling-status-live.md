---
"cognia-next": minor
---

The public status page (`/status`) now reports the real hosted relay instead of preview data. A separate status service measures `signaling.cognia.cn` every minute through its public route: the health endpoint, an authenticated two-peer signaling round trip, and the explicit data lane in both directions, plus simulated web, iOS and Android client origins. It publishes count-based history with coverage, where missing evidence shows as unknown and never as 100 %. The page also shows observer freshness, latency percentiles, incidents and maintenance windows, along with Atom/RSS feeds and double-opt-in email subscriptions with preference management and unsubscribe. Settings → Connectivity → Cloud & relay gains a link to the public status page that says it describes the official relay only, not a self-hosted one.
