---
"cognia-next": patch
---

Agent runner containers now carry ownership labels, so Cognia can prove which containers are its own and reap the ones a crash left behind. Ownership used to rest on a name convention (`cognia-agent-<id>`) plus a map held in memory: a container the user happened to name that way could be removed, and after a crash Cognia's own containers became unfindable — there was no way to ask the daemon which ones were ours, so every one of them leaked silently. Containers created by the Docker and Kubernetes paths are labelled with an owner, the agent id, the creating process, and a schema version; kill and remove refuse anything that does not carry the owner label; and the headless server reaps containers labelled by a previous run at boot.
