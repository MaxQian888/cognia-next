/**
 * `@cognia/companion-client` — the device-authenticated client for a Cognia
 * Host, shared by the app renderer, the CLI worker, and the browser extension.
 *
 * It exists because the DPoP proof is not RFC 9449 (see `./dpop`), so every
 * client has to implement Cognia's exact variant. Two hand-written copies had
 * already diverged in what they cached and how they reported refusals; a third
 * for the extension would have made that permanent.
 */
export {
  base64UrlToBytes,
  base64UrlToText,
  bytesToBase64Url,
  textToBase64Url,
  utf8ByteLength,
} from "./base64url"
export { CompanionApiError, companionErrorCode, expectCompanionJson } from "./errors"
export { createDeviceProof, type DeviceProofInput } from "./dpop"
export { signerFromCryptoKey, signerFromJwk, type DeviceSigner } from "./device-signer"
export {
  createCompanionSession,
  type CompanionFetch,
  type CompanionSession,
  type CompanionSessionOptions,
} from "./session"
export {
  decodeBrowserEnrollmentPayload,
  encodeBrowserEnrollmentPayload,
  type BrowserEnrollmentDecodeOutcome,
  type BrowserEnrollmentPayload,
} from "./browser-enrollment-payload"
export * from "./browser-companion"
