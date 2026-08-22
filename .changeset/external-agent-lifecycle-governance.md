---
"cognia-next": minor
---

External agents: one lifecycle, real secrets storage, and a runtime catalog that says what may run.

**Adding, editing and deleting an external agent now takes effect immediately.** Agents added from Settings were saved but not registered with the runtime until the next restart; an edit left the runtime running the previous configuration; a delete could leave the child process alive. The same was true of changes made from a paired device. Every one of those paths now runs through a single lifecycle service: creating an enabled agent connects it, a change to the launch command or endpoint rebuilds the connection, and deleting one ends its sessions and stops its process before the record goes away.

**Your agent credentials have moved out of app storage and into the OS keyring.** API keys, bearer tokens, authorization headers, proxy logins and secret environment variables were kept alongside the rest of the configuration and travelled inside exports. They now live in the same secure store the rest of the app uses, and are read only at the moment a connection is made. Existing agents migrate automatically the first time the app starts. Exporting an agent now produces a configuration with the secrets removed and a note of which ones the importing side has to supply, instead of one that silently carries them.

**An agent that cannot honestly start says why, instead of failing quietly.** At startup each agent is checked — is its adapter still installed, can its credentials be found, does this platform support it — and anything that fails is left switched off with the specific reason attached, rather than auto-connecting into an error.

**Every shipped agent runtime is now catalogued.** The catalog records where a runtime comes from, which platforms it supports, how to read its installed version, and which versions are certified. Removing an agent's configuration and uninstalling a shared runtime are now separate actions, and a runtime cannot be uninstalled while sessions are still using it or while another agent still points at it — a check that previously could never fire because the live-session count was always reported as zero. Cognia never removes a runtime you installed yourself.

**Cognia can now install an agent runtime and take it back out again.** Managed installs go to a staging area first, get checked against their expected version and checksum, and have to actually start before they replace anything — so a failed install leaves your working version untouched, and one healthy previous version is kept so you can go back. Package installs use a locked dependency list rather than resolving fresh at install time, downloads are checksum-verified before anything is unpacked, and switching to a different package manager asks first because it changes what gets installed.

**Installing an agent CLI from the terminal app now tells you who manages it.** Those installs go through your own package manager (npm, Homebrew, a vendor script), so Cognia cannot verify, update or remove them afterwards — the install screen now says so instead of looking the same as a managed install.

**Cognia now reads the version of each agent runtime you have installed, and says whether it has been certified.** A new "Installed runtimes" screen in External Agent settings lists the runtimes your configured agents actually use, with the installed version, the versions Cognia supports, the program that would run, how many agents use it and how many sessions are live. Nothing there is guessed: the version comes from running the runtime's own `--version`, and a device that cannot check — a browser or a phone — says so instead of reporting that nothing is installed.

The version check previously could not work at all. The recorded probe commands were assembled wrongly and would have started the agent instead of printing a version, and four of them would have reported the version of `npx` rather than the agent's.

Four agent runtimes (the Codex, Gemini, Qwen and Pi adapters) still start through `npx`, which fetches the package fresh on every launch. That is now recorded as a known gap with a written reason and counted by a build check, and the runtimes screen marks each one, so the version you are shown is never mistaken for a promise about the next launch.

**An agent that cannot start now says which part is missing.** Cognia has always checked each agent at startup — is its adapter installed, can its credentials be read, does this platform support it — and switched off the ones that fail. That verdict was recorded and never shown, so a blocked agent looked exactly like one you had turned off yourself. It now states the reason on the agent's page.

**On Windows, an agent that needs your permission to run outside the sandbox can now be given it.** The confirmation, and the standing "no sandbox" marker on an agent you allowed, existed but were never reachable. Approving one re-checks the program on disk first, so the permission is tied to the exact executable and version it was granted for — and is withdrawn automatically if either changes. That check previously compared a record against itself and could never notice.

Installing, updating and removing a runtime for you is still unavailable and now says so plainly instead of failing in an unclear way. Browsing the online agent directory is not available yet either.
