---
"cognia-next": patch
---

Unify the SSRF policy behind a single shared classifier (`@cognia/network-guard`), closing gaps where the three previous copies disagreed. The `web_fetch` tool and twin URL ingest now block IPv6 private targets they previously allowed outright — `http://[::1]/`, `[::]`, link-local, unique-local and site-local addresses all reached the network because the guard compared a hostname the URL parser returns with its brackets still attached. Web-clone snapshots and inbound connector media now also block IPv4-mapped IPv6 literals such as `http://[::ffff:169.254.169.254]/`, which the parser re-serialises to hex and the old text matching never caught. Inbound connector media additionally picks up the CGNAT, multicast/reserved and bare-integer IPv4 rules the other two guards already had, and `.local` mDNS names are now blocked everywhere. The "allow private hosts" opt-in still lifts every private-host rejection where it was already offered.
