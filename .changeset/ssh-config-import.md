---
"cognia-next": minor
---

Import your existing SSH hosts from `~/.ssh/config`.

Settings can now read the config file you already have and turn its `Host` blocks into saved profiles, including `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `LocalForward`, and `RemoteForward`. A `ProxyJump` naming a host with no block of its own gets a bastion profile created for it, and a comma-separated chain is linked hop by hop in the right order.

The preview is the point. An OpenSSH config says more than a host list can hold, so nothing is imported silently: every entry is listed with what will happen to it, and everything left behind is named with the line it came from — `Host *` and other patterns, `Match` blocks, `Include` files that were not followed, `ProxyCommand`, and any directive this app does not model. Two narrowings are labelled on the entries they apply to: a forward binding something wider than loopback is brought back to `127.0.0.1`, and remote forwards arrive switched off, because turning one on opens a listening socket on a remote machine.

Conflicts are resolved per entry, so one clash cannot force an all-or-nothing choice over the rest of the file. A host already in your list defaults to being replaced, keeping whatever password or passphrase it has in the keyring — `~/.ssh/config` has never held a secret, and an import must not orphan one. If you decline to import a jump host, the profiles that needed it say so rather than quietly connecting direct to a different machine.

This is a one-way import: nothing is written back to the file, and nothing watches it for changes.
