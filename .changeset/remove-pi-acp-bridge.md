---
"cognia-next": major
---

Remove the community `pi-acp` ACP bridge. Pi is driven only by its native
`pi-rpc` adapter now, and the bridge's preset, runtime, ecosystem surface, npx
allowlist entry and in-place migration are all gone. The bridge required the
same sandbox and the same platforms as the native adapter and bridged to the
same `pi --mode rpc` protocol, so its only remaining difference was covering Pi
versions the app already refuses natively — while re-resolving a third-party
package from the network on every start. Any config still pointing at
`npx -y pi-acp` is refused at launch instead of quietly running it.
