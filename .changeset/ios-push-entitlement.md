---
"cognia-next": patch
---

Fixed iOS push notifications: `pnpm mobile:sync:ios` now writes the `aps-environment` entitlement and links it into both build configurations. Previously this was a manual Xcode step, so a freshly synced iOS build could never register with APNs.
