---
"cognia-next": patch
---

Capability-gated surfaces can now say why they are unavailable instead of vanishing. A new resolver answers "can this run from here, and if not, why", separating four situations that a bare `isTauri()` check collapsed into one blank space: there is no host at all, the work needs the desktop process itself, the paired host does not offer it, or this build cannot do it on this machine. The MCP settings Agents tab is the first adopter and now explains itself rather than rendering an almost-empty tab.

Also fixes a class of misclassification: six hand-rolled copies of "is there a host" all reported the headless brain as a standalone browser, because it has no Tauri marker, no Capacitor and no pairing of its own. Git bridge availability, subscription host detection, logging telemetry attachment and the device console all asked that question and got the wrong answer on the one process that IS the execution plane.
