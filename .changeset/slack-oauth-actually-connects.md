---
"cognia-next": minor
---

Slack OAuth works. It previously could not succeed at all: the settings dialog stored the CSRF state under a key the deep-link router never read, minted a bare UUID where the completion handler required `slack:<adapterId>:<nonce>`, took the client id from a `NEXT_PUBLIC_SLACK_CLIENT_ID` env var that is set nowhere while the exchange read a per-adapter keyring entry the dialog never wrote, and pointed Slack at a `cognia://` redirect Slack refuses to register. Every attempt ended on "OAuth state mismatch".

The flow now mirrors the Lark one end to end and runs in the brain on both hosts: the dialog collects the Slack app's client id/secret into the keyring, `beginSlackOAuth` mints and durably persists the pending authorization before handing out the URL, and a new `/oauth/connector/{kind}/callback` relay on the connectors ingress fans the result to the desktop deep link and to the headless brain alike. A self-hosted install authorizes with `cognia-agent lark authorize` (the operator verb now dispatches on the adapter's own type and names the right developer console). The completion handler validates against the durable record — not browser storage — and spends it before the exchange, so a replayed redirect cannot reuse it.
