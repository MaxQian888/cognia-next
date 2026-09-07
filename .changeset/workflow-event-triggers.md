---
"cognia-next": minor
---

Workflows can react to four more things: a plan event, a scheduled task finishing, a captured item, and a memory being written.

The plan trigger closes the oddest gap in the set. There were seventeen plan nodes and no way to react to one, so anything waiting on an approval or a step failure had to poll. Fixing it also surfaced that plan step failures were declared in the type and appended by nobody, so "when a step fails" would have been a filter that could never fire. It fires now.

The scheduler trigger reacts to somebody else's task, including when it fails, which the existing scheduler event could not see at all. A workflow-type task cannot re-trigger the workflow it runs.

The two sensitive ones stay sensitive. A captured item carries ids and classification, plus the host of its source URL but never the path or query where tracking identifiers live, and its text only when you ask and only through the redaction gate. A memory trigger never carries the memory text at all: read it downstream if you need it, through the gate that read normally passes.

Also mounts the pet and issue triggers on cloud hosts, where both were quietly dormant, and fixes two trigger kinds whose registration was failing invisibly.
