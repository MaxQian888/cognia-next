---
"cognia-next": patch
---

A repository cloned into an E2B sandbox no longer carries your GitHub token in the clone URL or on any command line, where anything the agent runs could read it. The credential is supplied per command instead, and a sandbox that cannot accept it is refused rather than falling back. Pushing from a long-lived sandbox workspace also works again after the installation token rotates.
