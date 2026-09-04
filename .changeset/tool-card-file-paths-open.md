---
"cognia-next": minor
---

File paths in the Read, Glob, Grep and NotebookEdit tool cards are clickable, revealing the file in the right rail's workspace editor at the reported line. Relative paths work too — `Read` accepts one and `Glob`/`Grep` report them by default — resolved against the conversation's own execution root. A path that lands outside that root says so instead of doing nothing.
