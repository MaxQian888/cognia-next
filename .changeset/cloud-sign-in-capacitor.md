---
"cognia-next": patch
---

Cloud sign-in works on the phone. The Capacitor shell now signs in through the system in-app browser and the `cognia://logto/callback` deep link registered on the native Logto application instead of a popup the WebView cannot open. The pairing page asks for the organizations scope, so the session it leaves behind can adopt an organization afterwards.
