---
"cognia-next": patch
---

External agents: the runtime chip keeps a companion's chosen agent instead of resetting it to the built-in lane while a paired Host is still handshaking, and a blocked row now names the real obstacle (no Agent Control grant, Host still reporting, Host cannot spawn) rather than telling every browser user to install the desktop app. Manage Agents re-enables Connect on its own once the Host finishes connecting. A model picked from an agent's own list no longer follows the conversation back onto the built-in runtime. Installed-runtime detection re-asks when the paired Host changes, `pi auth check` runs once per agent instead of once per badge, and a connect that fails from the composer chip says so where you pressed it.
