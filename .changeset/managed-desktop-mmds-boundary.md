---
"cognia-next": patch
---

Require a fail-closed guest isolation guard for managed E2B desktop startup. The guard confines desktop processes to a loopback-only namespace with mandatory privilege removal and seccomp, and exposes the existing authenticated GUI protocol through a fixed Unix-socket relay. Record the approved MMDS control-plane boundary and require a new pinned image recipe. Provider enablement remains dormant pending exact-image lifecycle, handoff and control qualification.
