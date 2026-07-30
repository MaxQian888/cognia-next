---
"cognia-next": minor
---

Settings you change on the phone now actually reach the paired desktop, and stop snapping back to the old value.

Two things were wrong at once. Mobile pages that embed a desktop settings section — `/me/appearance` renders the desktop appearance panel whole — wrote only to the phone's own database. The step that hands the change to the desktop lived in a helper that nine other `/me` pages called and this one structurally could not, so themes, custom themes, wallpapers, accent colour, custom CSS and imported VSCode themes changed on the phone stayed on the phone forever. The server had thirteen fields allowlisted specifically so those tabs would work, and not one of them was ever sent. That step now happens once, where settings are persisted, so every screen gets it — including whichever desktop section is reused next.

The other was a visible flicker: change settings on a phone with no connection, and the moment it reconnected the first sync overwrote your edits with the desktop's older values, so the UI snapped back to the old setting and then changed again a second later once the queued writes drained. Fields with a write still waiting in the queue are now left alone until it lands. Writes that failed permanently are deliberately not protected — the desktop's value wins, because otherwise the two devices would never agree again.

Three settings deliberately stop travelling, because sending them was wrong rather than useful: biometric requirements belong to each device's own authenticator, the workflow editor's performance tier is chosen for one device's graphics, and the selected microphone is an identifier that means nothing elsewhere. Each still works normally on the device you set it on.

`/me → Network` gains a read-only "Direct connection" panel showing the signaling server this device will actually dial, how many STUN and TURN servers it received, and whether those came from the host or are the built-in defaults. This was previously impossible to see and quietly wrong: a self-hosted signaling server or TURN relay configured on the desktop never reached the phone, and the only symptom was a direct connection failing on strict networks.
