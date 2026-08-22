---
"cognia-next": minor
---

External agents: one lifecycle, real secrets storage, and a runtime catalog that says what may run.

**Adding, editing and deleting an external agent now takes effect immediately.** Agents added from Settings were saved but not registered with the runtime until the next restart; an edit left the runtime running the previous configuration; a delete could leave the child process alive. The same was true of changes made from a paired device. Every one of those paths now runs through a single lifecycle service: creating an enabled agent connects it, a change to the launch command or endpoint rebuilds the connection, and deleting one ends its sessions and stops its process before the record goes away.

**Your agent credentials have moved out of app storage and into the OS keyring.** API keys, bearer tokens, authorization headers, proxy logins and secret environment variables were kept alongside the rest of the configuration and travelled inside exports. They now live in the same secure store the rest of the app uses, and are read only at the moment a connection is made. Existing agents migrate automatically the first time the app starts. Exporting an agent now produces a configuration with the secrets removed and a note of which ones the importing side has to supply, instead of one that silently carries them.

**An agent that cannot honestly start says why, instead of failing quietly.** At startup each agent is checked — is its adapter still installed, can its credentials be found, does this platform support it — and anything that fails is left switched off with the specific reason attached, rather than auto-connecting into an error.

**Every shipped agent runtime is now catalogued.** The catalog records where a runtime comes from, which platforms it supports, how to read its installed version, and which versions are certified. Removing an agent's configuration and uninstalling a shared runtime are now separate actions, and a runtime cannot be uninstalled while sessions are still using it or while another agent still points at it — a check that previously could never fire because the live-session count was always reported as zero. Cognia never removes a runtime you installed yourself.

**Cognia can now install an agent runtime and take it back out again.** Managed installs go to a staging area first, get checked against their expected version and checksum, and have to actually start before they replace anything — so a failed install leaves your working version untouched, and one healthy previous version is kept so you can go back. Package installs use a locked dependency list rather than resolving fresh at install time, downloads are checksum-verified before anything is unpacked, and switching to a different package manager asks first because it changes what gets installed.

**Agent directory listings now say which agents Cognia can install for you.** Agents published with a verified download are installable in place; the rest are listed with a link so you can install them yourself, instead of being offered an install that would fetch an unverified package.

**Installing an agent CLI from the terminal app now tells you who manages it.** Those installs go through your own package manager (npm, Homebrew, a vendor script), so Cognia cannot verify, update or remove them afterwards — the install screen now says so instead of looking the same as a managed install.

Four agent runtimes (the Codex, Gemini, Qwen and Pi adapters) still start through `npx`, which fetches the package fresh on every launch. That is now recorded as a known gap with a written reason and counted by a build check, so it can be closed rather than forgotten.
