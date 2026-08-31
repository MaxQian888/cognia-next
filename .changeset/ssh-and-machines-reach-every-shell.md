---
"cognia-next": minor
---

SSH hosts, remote hosts and Docker machines are now describable, testable and reachable from `/devices` on all three shells.

An SSH row in the fleet console shows what was always in its saved profile and never on screen: the address, the auth method with whether the secret it needs is actually stored, the jump chain drawn as the ordered route it is, and the forwarding rules in both directions with their on/off state. A chain that cannot be resolved is refused rather than quietly connecting direct to a different machine.

A **Test connection** button gives an SSH host a real presence signal for the first time, so its row stops reading `unknown` forever. It makes a real connection through the whole jump chain, never binds a port, and says up front what that costs: it authenticates, lands in the target's and every bastion's log, may prompt an ssh-agent, and trusts the host key on first contact. The result expires after ten minutes and is dropped when the host's address changes.

**A changed host key is now re-trustable wherever you connected.** Previously only Settings could adjudicate one, while the device console and the terminal dock printed the raw `ssh_host_key_changed:{…}` payload with no way forward. On a phone or a browser the mismatch and both fingerprints are still shown, with the re-trust pointed at the desktop that owns the host.

**A phone, a browser, or a desktop driving a remote host can now open an SSH session.** The paired host makes the connection from a profile id, with credentials that never leave it. The mobile terminal gains the same shell picker the desktop dock uses. A host that does not have the named profile says so instead of returning a native error string.

**Docker machines gained a shell and a summary.** The device console now counts machines by state and says what an idle one costs, and a running machine can be opened as a real terminal, with tabs, replay, search and history, rather than only accepting one-shot commands. `cua-cloud` and `lume` are labelled as declared providers with no adapter wired instead of appearing usable.

**`/servers` works on a phone.** The deployment fleet, the target detail with all five tabs and every action, and the operations rail behind a labelled trigger carrying the in-flight count. Previously it rendered as a desktop three-pane squeezed into two 16px panel icons.

Three smaller honesty fixes: `/me/terminal` now sends a standalone browser to pairing instead of a dead screen, the paired-device terminal grant says why it is unavailable rather than sitting disabled in silence and states that it also reaches this machine's saved SSH hosts, and each capability cell finally names where its answer came from.
