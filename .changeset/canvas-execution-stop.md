---
"cognia-next": minor
---

Stop now stops a Canvas Python run. It used to abort a signal only the browser side could see: the interpreter kept going to its 30-second timeout, holding whatever it had opened, while the panel showed nothing running. A run carries an id the desktop host can kill by, and cancelling returns the output the program had produced up to that point.

Settings → Canvas → Execution does something now. The timeout, "show output" and "clear output on run" are read by the runtime. Four controls were removed instead of left inert: auto-execute, variable preservation, a "strict / permissive" sandbox mode and a Python runtime picker. None had an implementation, and the last two read as security and capability controls while doing nothing. Confinement is Settings → Sandbox, and whether Python can run is now answered by the host: Run is disabled with a reason instead of failing after the click.
