/**
 * The plugin contract's share of `packages/plugin-sdk/src/api/character-pack.ts`, which re-exports these.
 */

export interface LocalCharacterPackSignature {
  algo: "ed25519"
  pubKey: string
  sig: string
}
