---
"cognia-next": minor
---

Lark send-as-user OAuth is now driven end to end by the brain, which makes it work on self-hosted deployments for the first time. The `state` and PKCE verifier used to be minted in the settings dialog's browser `localStorage` while the code exchange happened in the brain — the same process only on the desktop, so a self-hosted install could never complete an authorization. Both halves now run in the brain and the pending record lives in the adapter's encrypted secret store (durable on both hosts, no schema change). Desktop behaviour is unchanged apart from the verifier no longer sitting in Web Storage.

Headless installs, which have no settings dialog, get a new operator command:

```
cognia-agent lark authorize --adapter <id> [--redirect <url>]
```

It prints an authorize URL to open in a browser; the redirect defaults to `$COGNIA_LARK_PUBLIC_BASE/connectors/oauth/lark/callback`, and completion lands in the running `serve` process.
