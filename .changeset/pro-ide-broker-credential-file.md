---
"cognia-next": patch
---

Pro IDE no longer exposes its broker secret to commands run inside VS Code. The secret used to sit in code-server's environment, so any terminal, task or language server in the workbench could read it and take over the editor connection. It now travels as a single-use file the Cognia extension deletes on read, reconnects use a derived session key that never crosses the wire, and if something else reads the file first Cognia revokes the connection, issues a new key and tells you. The retired newline protocol is gone, and a broker build that fails its integrity check or install is reported instead of silently leaving agent drive off.
