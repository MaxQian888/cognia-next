---
"cognia-next": patch
---

Fix process-management correctness: code-server instances and the cloudflared tunnel are now stopped on app exit instead of being orphaned, exited terminal sessions report as stopped (and are no longer resurrected as dead tabs on reload, nor can their reused PID be signalled), the performance panel's process tree once again classifies the Node sidecar, and closing the panel no longer freezes the status bar's perf readout.
