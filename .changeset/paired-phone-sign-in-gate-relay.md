---
"cognia-next": patch
---

A paired phone no longer stops at a full-screen "can't sign in right now" when its Host is only reachable over the relay. A LAN Host uses a self-signed certificate that was pinned at pairing. When the phone's native HTTP stack cannot enforce that pin, all Host traffic already goes over the relay data lane. The sign-in gate, however, tried to read the Host's login configuration directly, which can never succeed on such a build (`native_spki_pinning_unavailable`). The gate now lets a pairing that has a relay route through. A pairing with no relay route at all still shows the screen.
