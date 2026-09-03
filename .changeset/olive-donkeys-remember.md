---
"cognia-next": patch
---

Stop the development web shell from asking for the account password on every reload. A successful unlock is now remembered for the lifetime of the browser tab, so HMR reloads and navigations to /pair, /settings or /onboarding keep the session open. Locking still locks, production builds are unaffected, and NEXT_PUBLIC_ACCOUNT_GATE=1 restores the real password flow in a dev build.
