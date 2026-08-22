---
"cognia-next": patch
---

An inbound attachment can no longer point the app at your own network.

The address a chat platform reports for an attachment is data that arrives from outside, and the app fetched it without checking where it pointed. A message could name `http://127.0.0.1:…` or a machine on your LAN and the app would request it. Attachment downloads are now refused for loopback, private and link-local addresses, and for anything that is not http(s).

One exception, and only where it is the intended setup: a self-hosted OneBot implementation usually serves media from its own address, so the host you entered in the connector's own settings is allowed. Any other private address in a message is still refused.
