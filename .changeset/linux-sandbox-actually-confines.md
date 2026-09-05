---
"cognia-next": patch
---

The built-in execution sandbox now works on Linux. It never has.

Every sandboxed command on Linux failed with exit 1, no output, and `bwrap: Failed to make / slave: Operation not permitted` on stderr. The syscall filter that is meant to harden the sandboxed process was being installed on `bwrap` itself, one step before it execs, so it denied the `mount`, `unshare` and `pivot_root` calls bwrap needs to build the sandbox at all. The filter is now handed to bwrap on a descriptor and lands where it belongs, on the sandboxed process. As before, the settings badge reported the backend as Active throughout, because a present binary is not evidence that it confines.

The mounts that hide credential stores could be redirected to serve them. The empty directory bound over `.ssh`, `.aws`, `.gnupg` and the rest lived in the shared `/tmp`, where any local account can create it first, and a symlink planted there decided what the sandbox saw at every one of those paths. Those mounts are now an empty read-only tmpfs with no host path to aim at.

A missing secret directory under a readable root failed the entire call, because bwrap has to create a mount point and a readable root is mounted read-only. One absent `.gnupg` was enough to break every command naming that root.

`sandbox_write` could not create a file that did not exist yet, so the same tool call succeeded on macOS and refused on Linux.

A host that will not grant a user namespace now refuses with the reason and the remedy instead of returning an exit code that reads as an ordinary command failure. Ubuntu 24.04 and later reach this out of the box, and their bubblewrap package ships no AppArmor profile of its own.

Sandboxed processes are also detached from the terminal that launched the app, so they cannot push input back into it.
