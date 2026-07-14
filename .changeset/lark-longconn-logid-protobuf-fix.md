---
"cognia-next": patch
---

Fix the Lark (Feishu) long-connection never receiving any inbound events. The hand-written pbbp2 `Frame` protobuf declared `logid` (field 2) as a `String`, but the live server sends it as a numeric varint — so prost rejected **every** inbound frame with "logid: invalid wire type: Varint (expected LengthDelimited)" and silently dropped all events (message receives, bot-menu clicks, everything). The connection handshake succeeded and the socket stayed open, so the bot looked "connected" but never responded and its health stayed stuck at "starting". `logid` is now decoded as `uint64`. Decode failures, previously logged at `debug` (invisible at the default INFO level), are now logged at `warn` with a hex preview so a future protobuf drift is caught immediately.
