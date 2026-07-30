---
"cognia-next": minor
---

Ask a remote host what it can do, instead of assuming it is like this machine.

When you connect to another Cognia host, the app had no way to find out what that machine is capable of. The only capability list it kept was for devices that had paired _into_ this machine — phones, tablets — and connecting to a host runs the other way round, so the host you are driving was never in it. Everything was therefore judged by the local machine's own abilities: a workflow that needed something only a server can offer, like staying awake without a window open, was refused before it started even when the server you were connected to could have run it perfectly well.

Hosts now answer for themselves. On connecting, the app asks and remembers, and Settings → Remote hosts lists what came back — or says plainly that it has not asked yet. A host too old to answer, or briefly unreachable, keeps whatever it last reported rather than being blanked, because a slightly stale answer is still better than falling back to guessing.

The host answers through its own application layer rather than its network front door, so a desktop and a headless server both report themselves using the same definition of what a capability is.

This makes the cloud host visible and stops it being misjudged. It does not yet move work there: a scheduled task still runs wherever it was scheduled, and nothing hands it to a server when your desktop is off.
