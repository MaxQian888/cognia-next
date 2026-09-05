---
"cognia-next": minor
---

Remote connectivity works from any network. The hosted signaling rendezvous now carries the application data lane (ADR-0170), so a phone or browser reaches a Host through the relay when a direct or peer-to-peer path is unavailable, and pairing invitations (`cgnp4`) carry a relay room so first pairing no longer needs the same Wi-Fi. A browser paired to a headless server configures its relay, browser access, push credentials and invitations exactly as the desktop does, over the new owner-authenticated host-admin RPC plane. Settings gains one Connectivity section (Overview, Local host, Cloud & relay, Pairing, Remote hosts, Push, Sync) replacing Mobile companion and Remote hosts, with the same pair flow on desktop, web and mobile. Pause/resume/revoke on the device console work from paired companions, Push has a test notification, and a degraded event plane is now detected and shown.
