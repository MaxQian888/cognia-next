---
"cognia-next": patch
---

Phones and browsers keep receiving live updates after their Host restarts: a resume cursor left over from the Host's previous run now triggers a resync instead of silently discarding every new event, which had left Host-run agent replies unrendered and a stopped turn stuck on "sending".
