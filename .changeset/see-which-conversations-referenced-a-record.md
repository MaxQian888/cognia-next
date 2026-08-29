---
"cognia-next": minor
---

See which conversations have referenced a record.

Every turn that cites something — a memory, an issue, a plan, another conversation — has recorded that citation on the message since the reference system landed. Nothing ever read it back the other way, so the app could tell you what a message referenced and never what referenced a record.

A conversation's header now carries a "Referenced by N conversations" chip beside the existing branch and import chips, and a memory's or an issue's detail view lists the same thing inline. Each row lands on the exact turn that made the citation, not on the conversation's tail. Both self-hide when nothing has referenced the record.

Also fixed on the way past: a memory's "jump to source" landed on the conversation rather than on the message that taught it, even though the message id had been recorded all along.
