---
"cognia-next": patch
---

Security: a paired Browser Companion extension can no longer be granted anything beyond `browser.submit` and `browser.read-own`. Before this fix, the companion security store accepted terminal, remote-control, agent-control, SSH-file and worker grants for a browser device when they arrived through the desktop grant commands, `fleet_worker_set`, the Owner API (`PUT /api/devices/{id}/capabilities`) or `cognia-server devices grant`. All of those paths are now refused with a typed `capability_outside_device_class` error (HTTP/RPC 403). The legacy grant import skips browser devices, and a service principal can no longer take over a browser device's id. Any out-of-class grant already stored for a browser device is revoked the next time the store opens, and each affected device gets an audit entry. Removing grants from a browser device, and all grants on phone and desktop devices, work as before.
