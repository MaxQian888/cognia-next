---
"cognia-next": minor
---

VS Code extensions from Open VSX are checked against Open VSX's signature, and extensions it does not vouch for need your trust before they start. Every download's `.sigzip` signature is verified on the desktop against Open VSX's key, which is built into Cognia rather than taken from the registry. A signature that does not match stops the install. A verified extension shows "Signed by Open VSX" and starts as before. An extension added from a `.vsix` file, one signed by a key Cognia does not know, or one installed before this check existed has nothing vouching for it, so it starts only after you turn on "Trust this extension" in its Permissions section; the install dialog and the error say so. VS Code extensions no longer go through the plugin signature policy, which none of them could pass before, so with that policy on (the default) no VS Code extension could start at all.
