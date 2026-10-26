---
"cognia-next": patch
---

A multi-tenant Host no longer drops every paired device's event stream while an org member's reply streams: each member event now crosses the Host once instead of once per device they ever paired, so live replies keep arriving and member push notifications still reach their current devices.
