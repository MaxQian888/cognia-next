---
"cognia-next": minor
---

Rebuild the account lock screen. Unlocking now shows a spinner, a changed button label and the live pipeline stage (verify → runtime → database → workspace) instead of only greying the button out, with a watchdog that says when it is slow and offers stop/copy-details/reload when it is stuck. The password field takes focus on mount, gained a reveal toggle and a Caps Lock warning, failures render translated messages instead of raw English error text, repeated wrong passwords back off, and a multi-account lock screen can pick which account to unlock. The Browser Vault recovery key can finally be redeemed — it sets a new password in the same step. Locking now releases live runtime subscriptions before closing the database and can no longer fail open, and the two competing idle auto-lock timers were merged into one that never fires mid-run or from an overlay window.
