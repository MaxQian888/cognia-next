---
"cognia-next": minor
---

Workflows can now drive the embedded Pro IDE. Six new nodes — Open in editor, Reveal in editor explorer, Show diff for review, Read active editor, Reflect edit in editor, and Save editor buffers — let a run surface a file, park a proposed change in VS Code's native diff view for review, or read back what the user is focused on. Each targets the Pro IDE you already have open, or an explicit workspace you name, and only starts code-server when you switch on "Start the IDE if needed". Reading the active editor is PII-screened before it enters the run, using the same gate the chat agent's editor tool uses. The nodes are greyed out wherever code-server cannot run.
