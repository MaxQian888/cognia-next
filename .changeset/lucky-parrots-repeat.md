---
"cognia-next": patch
---

Fix the conversation label catalog rendering empty. The settings label manager, the Inbox label picker and the row/header chips read the label list from the legacy `conversationLabels` table, which schema v170 stopped writing to when it folded the catalog into the shared `labels` table. A fresh install therefore had no labels at all, and an upgraded one showed its pre-v170 snapshot and never reflected a label created since.
