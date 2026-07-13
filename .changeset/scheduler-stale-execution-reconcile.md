---
"cognia-next": patch
---

Stop scheduled-task run history from showing executions stuck "running" after a restart. An execution's live controller only exists in the process that started it, so a reload or crash mid-run left the stored row marked running forever (the missed-task sweep only reconciles tasks, not executions). On startup the scheduler now cancels any orphaned running/pending execution, tagging it "interrupted-on-restart" so the history reflects what actually happened.
