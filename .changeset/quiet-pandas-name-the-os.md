---
"cognia-next": patch
---

Report the real OS family (macos / windows / linux / ios / android) instead of the frozen `navigator.platform` string, so diagnostics no longer read "MacIntel" on an Apple Silicon Mac and an iPad is no longer treated as macOS.
