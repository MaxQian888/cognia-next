---
"cognia-next": patch
---

Settings: a sweep of controls that saved a value and then changed nothing.

- **Language Servers** gains a Runtime block. The section could add servers but not switch the subsystem on: the master enable, the auto-install ladder, and the unsigned-binary allowance were all read at runtime with no control anywhere. Turning the subsystem off now also stops the editor's language servers, not just the agent's.
- **Computer Use (mobile)**: the master switch on the phone now actually refuses a computer-use turn. It described itself as overriding the per-character setting while nothing read it, so a phone could drive the desktop's mouse and keyboard with the switch off.
- **Scheduled Tasks → Defaults for new tasks** now reaches new tasks. Timezone, notification triggers and channels, webhook URL, timeout, retries, missed-run and concurrency defaults were persisted and then ignored. The chat channel is also selectable there for the first time, along with the global ops conversation its notifications fall back to — the channel test used to fail naming a setting the app offered no way to set.
- **Canvas** version and AI preferences take effect: diff view mode, per-version timestamps, the version ceiling and whether named versions are exempt from it, and a suggestion's confidence badge. Streaming responses, inline completion, and old-version compression remain inert.
- **Agent evaluation** exposes how much of each answer is kept on a result row, so a failed case can be read back instead of showing only a score.
- **Security**: the biometric rows now govern. Requiring verification to reveal a stored API key or token had no effect at all; requiring it to delete a pairing was ignored by the device console; requiring it to sign out was honoured on one of the two sign-out surfaces. Defaults are unchanged.
- The settings page's **Reset** button is back on the section it opens on, and the changed-settings review no longer prints a raw section id as a heading.
