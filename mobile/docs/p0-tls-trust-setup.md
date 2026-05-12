# P0 — Mobile-side TLS trust setup (M2.9 follow-up)

Status: **JS layer done. Android native config landed. iOS PENDING (requires `cap add ios` + Apple Developer account + device build).**

After M2.9 the desktop companion server terminates HTTPS with a self-signed certificate generated at runtime by `src-tauri/src/companion_api/tls.rs`. The JS layer routes through `CapacitorHttp` with `serverTrustMode: "self-signed"` (see `lib/tauri/pinned-fetch.ts`). The remaining work below is required for true cert pinning at the platform layer.

## What the JS layer already does

- `mobile/capacitor.config.ts` enables the `CapacitorHttp` plugin.
- `lib/tauri/pinned-fetch.ts` branches `fetch` to `CapacitorHttp.request` on native platforms, with `serverTrustMode` picked per request:
  - LAN with pinned fingerprint → `self-signed` (accepts the cert, identity verified at app layer in P0.3)
  - `*.trycloudflare.com` → `default` (Cloudflare PKI)
  - LAN without pinned fingerprint → `default` (no pair yet — fails by design)
- `transport-companion.ts` passes `CompanionConfig.serverFingerprint` (loaded from the QR pair payload) into every call.
- Unit tests in `lib/tauri/pinned-fetch.test.ts`.

## Native steps still required

### Android — landed

`mobile/android/app/src/main/res/xml/network_security_config.xml` exists and is referenced from `AndroidManifest.xml` via `android:networkSecurityConfig="@xml/network_security_config"`. It grants user + system CA trust for `127.0.0.1` and `cognia-companion.local` so the Capacitor WebView accepts the desktop's self-signed cert via the user trust anchor pathway. Strict pinning to a build-time hash is **not viable** because the cert is generated at first desktop launch — identity is established at the app layer via the QR-encoded fingerprint + P0.3 attestation.

For reference, two paths considered but not taken:

1. **Self-signed acceptance for `127.0.0.1` + local IP ranges** (matches today's `serverTrustMode: "self-signed"` behavior):

   ```xml
   <network-security-config>
     <domain-config cleartextTrafficPermitted="false">
       <domain includeSubdomains="false">127.0.0.1</domain>
       <!-- LAN ranges. Tighten as needed. -->
       <domain includeSubdomains="true">cognia-companion.local</domain>
       <trust-anchors>
         <certificates src="user" />
         <certificates src="system" />
       </trust-anchors>
     </domain-config>
   </network-security-config>
   ```

   Then reference it from `AndroidManifest.xml`:

   ```xml
   <application
     android:networkSecurityConfig="@xml/network_security_config"
     ...>
   ```

2. **Custom Capacitor plugin** that exposes runtime cert pinning via `OkHttp`'s `CertificatePinner`. This is the only path to _strict_ pinning against a runtime-generated cert. Out of scope for the M2.9 landing; tracked separately.

### iOS — `mobile/ios/App/App/Info.plist`

Add an `NSAppTransportSecurity` exception for the LAN host pattern. Like Android, strict pinning requires a custom plugin; this exception covers the self-signed acceptance behavior:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSExceptionDomains</key>
  <dict>
    <key>cognia-companion.local</key>
    <dict>
      <key>NSExceptionAllowsInsecureHTTPLoads</key>
      <false/>
      <key>NSIncludesSubdomains</key>
      <true/>
      <key>NSExceptionRequiresForwardSecrecy</key>
      <false/>
      <key>NSExceptionMinimumTLSVersion</key>
      <string>TLSv1.2</string>
    </dict>
  </dict>
</dict>
```

For pairing against `127.0.0.1:7890` (loopback) and `192.168.x.y` (LAN IP), iOS requires a different approach — either install the desktop's cert as a profile or use the custom-plugin route.

### Verification

After native config lands:

1. `pnpm tauri dev` — generates a fresh `tls.pem` on first boot.
2. `cd mobile && pnpm sync && pnpm open:android` — install on device.
3. Pair via QR scan from the desktop's PairDeviceCard.
4. Confirm in the desktop's audit log (`Settings → Connections → Audit`) that an HTTPS request from the device arrives at `/api/v1/whoami` with `200 OK`.

## True pinning roadmap (not in scope this milestone)

If/when strict pinning becomes a hard requirement:

1. Write a Capacitor plugin `@cognia/cert-pinner` that exposes
   `setPinForHost(host: string, sha256Hex: string)` and a corresponding
   pinned-HTTP/WS client.
2. Mobile pair flow calls `setPinForHost(baseUrl.host, serverFingerprint)`
   after parsing the QR.
3. Replace `serverTrustMode: "self-signed"` with `serverTrustMode: "pinned"`
   in `pinned-fetch.ts` and route WebSocket through the plugin.

Until then, security model on LAN is "accept any self-signed cert + verify
fingerprint at app layer via P0.3 attestation flow". This is **stronger than
plain HTTP** (which is what shipped before M2.9) but **weaker than strict
TLS pinning** (which a real Capacitor cert-pinner plugin would provide).
