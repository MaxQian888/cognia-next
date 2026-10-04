---
"cognia-next": patch
---

Mobile: a phone whose native HTTP stack cannot pin the Host's self-signed certificate now reaches it over the authenticated relay instead of failing every request after pairing. Clients no longer reject a Host's feature manifest as incompatible when one operation belongs to two features (the external-agent tool host), which had blocked every headless Host from coming online. `cognia-server serve` now advertises itself over mDNS (opt out with `--no-mdns`) so the app's "Find your desktop" scan lists headless Hosts.
