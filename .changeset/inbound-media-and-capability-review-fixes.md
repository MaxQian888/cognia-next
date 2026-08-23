---
"cognia-next": patch
---

Closed a set of gaps in inbound attachment handling and in the external-agent capability answer.

The attachment download floor now reads IPv6 addresses instead of pattern-matching their text. The loopback and cloud-metadata addresses have an IPv6 spelling — `[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]` — that the previous check let through, and a message could name one. The OneBot exception for a self-hosted implementation is now the exact address you entered, port included, rather than every port on that machine, and it only applies while the connector is actually dialling that address.

Pictures now arrive as pictures more often. A file whose type is an image — how Telegram sends an uncompressed screenshot — is read by the OCR pass instead of reaching the model as a bare file name. The media type reported to the model is now read from the bytes themselves, so a QQ photo is no longer announced as a PNG and a redelivered picture no longer loses the type it had the first time. An attachment too large to inline is remembered as such, instead of being looked up again on every message that mentions it.

For external agents: on Windows the app now correctly reports that it cannot run one, rather than claiming every capability for an agent that could never start. The capability table resolves the sentences behind adapter-method verdicts instead of printing their internal key, and keeps showing an accurate `/compact` answer for the whole session. A plugin's capability declaration is validated before it is believed, and cannot certify itself as verified by Cognia. Pi turns report their context window and cost even when the final tally omits them, and a turn that settles twice can no longer deliver its events out of order.
