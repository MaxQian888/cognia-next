---
"cognia-next": patch
---

Chat: a send refused because the conversation's working copy is still held by an earlier turn now reports its own `workspaceBusy` diagnostic instead of reusing `workspaceUnavailable`, whose hint told the reader to bind the workspace to a folder. That was the one move that cannot help a binding which is already correct and merely busy. The card now says another turn is using the working copy and to wait for it, or send from the device running it, and offers just the retry. `DiagnosticCard` also gained the "show raw" disclosure that `CogniaDiagnostic.detail` was documented for and never had, so the stack traces and raw payloads its producers already attach are finally readable.
