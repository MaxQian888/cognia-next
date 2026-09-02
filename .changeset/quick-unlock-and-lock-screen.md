---
"cognia-next": minor
---

The lock screen can now be opened with a PIN, a pattern or a passkey, and it no longer has to look like a form on a blank page.

Set a method up in Settings → Account → Security. Each one takes your account password to add, because adding a PIN creates a new way into the account and a signed-in machine left on a desk should not be enough. Your password keeps working, stays one click away on the lock screen, and remains the only factor that can recover the account. PIN and pattern are convenience factors and are treated as such: both are combined with high-entropy material that never leaves the device (the OS keyring on desktop, a non-extractable key in the browser), so a copied profile cannot be used to guess them, and each carries a hard cap of five attempts after which it is disabled until you unlock with your password. Guessable PINs and patterns are refused at setup. Passkeys use the WebAuthn PRF extension, and an authenticator that cannot derive an unlock key is refused rather than enrolled as something that could never work.

The keypad and the pattern grid are built for a thumb and a keyboard alike: the pad takes typed digits without hunting for a button, and every pattern node is a real button, so the pattern is usable without dragging.

The lock screen itself is now configurable under Appearance → Personalization: a backdrop (the theme, your current wallpaper, a pinned one, or a solid colour), blur, dim, a clock with a choice of hour format, a greeting, optional ambient motion, and a switch to hide the account avatar on a shared machine. Nothing there can make the screen harder to use: the unlock card keeps its own surface throughout, and dropping the dim far enough that a bright wallpaper would compete with it now says so.
