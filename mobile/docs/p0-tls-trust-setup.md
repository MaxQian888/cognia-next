# Mobile TLS trust boundaries

Verified: 2026-10-02, Capacitor 8.5.2.

Stock CapacitorHttp uses Android/iOS certificate validation. It does **not** implement `serverTrustMode`, `serverFingerprint`, or `getSecurityCapabilities`. Passing unknown JS options cannot make a self-signed endpoint reachable or enforce pinning.

## Current routes

- `lib/tauri/pinned-fetch.ts` requires native SPKI capability attestation before sending a request to a paired LAN endpoint with its saved fingerprint. Without an implementation it fails closed with `native_spki_pinning_unavailable`; the companion transport can use its authenticated relay route (ADR-0170).
- Publicly trusted tunnel endpoints use system TLS trust. Pre-pair LAN probes likewise use system trust; an untrusted certificate causes that probe to fail.
- WebDAV on mobile requires a trusted HTTPS certificate. The desktop-only invalid-certificate option is not offered as a mobile capability; a saved enabled option must be turned off before mobile requests proceed.
- `requestCapacitorHttp` rejects cancelled or expired JS waits and discards late responses. Stock native I/O continues until its connect/read timeout; this does not claim transport-level cancellation.

## Native configuration

Android `network_security_config.xml` trusts installed user and system CAs for `127.0.0.1` and `cognia-companion.local`. Other hosts use system CAs. This does not automatically trust the desktop runtime certificate: an appropriate CA must already be installed. The optional build-time pin-set further restricts trusted chains and is not a substitute for runtime pairing pins.

iOS `NSAllowsLocalNetworking` is a local-network ATS setting, not a bypass of TLS certificate validation. An ATS exception alone cannot trust an arbitrary self-signed certificate.

Direct pinned LAN HTTP/WebSocket support requires a native implementation that validates the accepted SPKI fingerprint, handles certificate/hostname identity deliberately, and rejects mismatches. The current capability gate must remain until that implementation is present and tested on both platforms.

## Verification

Focused HTTP tests cover binary decoding metadata, pre-dispatch cancellation, late-result rejection, timeout/listener cleanup, and fail-closed pinning. WebDAV tests ensure an unsupported override cannot send credentials. Device acceptance still needs valid/untrusted certificates and a deliberately wrong pairing fingerprint; passing JS mocks alone does not establish native TLS enforcement.

Source: [Capacitor HTTP v8 options](https://capacitorjs.com/docs/apis/http).
