---
"cognia-next": minor
---

Wire up the SSH terminal so saved hosts are reachable and remote sessions stay identifiable.

`ssh-agent` authentication now works, making good on the claim in the original SSH release: pick "SSH agent" on a host and the signature is delegated to the running agent (`SSH_AUTH_SOCK` on macOS and Linux, the OpenSSH named pipe or Pageant on Windows), with no password, passphrase, or key path stored for that host. Every identity the agent holds is offered, including OpenSSH certificates.

Saved SSH hosts appear in the terminal dock's shell picker, so connecting no longer means a trip through Settings. A host that needs a password it has never stored is sent back to Settings with an explanation instead of failing on an opaque keyring miss.

Restored terminal tabs keep their SSH identity across a reload: the transport kind, profile, and host-key fingerprint survive, an SSH tab is titled by its target rather than the word "ssh", and it carries a server glyph so it is not mistaken for a local shell.

A changed host key is now a security warning rather than a bare connection error. The connection still fails closed and the trusted key is never overwritten; the dialog names the fingerprint you trusted alongside the one just presented, and re-trusting is a deliberate, local-only action.
