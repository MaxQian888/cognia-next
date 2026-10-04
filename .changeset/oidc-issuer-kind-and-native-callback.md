---
"cognia-next": patch
---

Sign-in works with standard OIDC issuers besides Logto: a deployment can announce `issuerKind: "oidc"`, and the apps then skip Logto-only parameters and return through the new `cn.cognia.app:/auth/callback` link, which desktop, iOS and Android now register. Logto deployments are unchanged.
