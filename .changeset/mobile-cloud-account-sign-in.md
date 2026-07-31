---
"cognia-next": minor
---

Sign in to a cloud Cognia account from the phone.

A multi-user cloud or self-hosted deployment authenticates through Logto, and the sign-in card lived only in the desktop's companion settings — where it also told you cloud sign-in was desktop-only. It never actually was: opening the authorize page already routes through the phone's in-app browser, the exchange is a plain PKCE flow, and the session store already had a non-desktop path. A phone connecting straight to a cloud server — the setup Logto exists for — simply had nowhere to do it.

There is now a Cloud account entry under Me. The card is the same one the desktop uses, so the two stay in step by construction.

One thing genuinely was broken underneath. Off the desktop the session is kept in an encrypted vault rather than the operating system keyring, and that vault refuses to store anything until it has been given its encryption key. Nothing ever gave it one for sign-in sessions, so a sign-in on a phone or in a browser would have completed the whole browser round-trip and then failed at the moment of saving the token. It now provisions that key the same way the plugin secret store does, and the card says plainly where your token ends up on each kind of device.
