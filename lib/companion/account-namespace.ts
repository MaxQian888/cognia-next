/**
 * The namespace a companion pairing is filed under before any account owns it.
 *
 * Its own module because both ends of the pairing path need the constant and
 * neither should pull the other's graph in: `credential-book/types` re-exports
 * it for the client book, and `event-bridge` compares inbound Rust events
 * against it. The Rust half is `LOCAL_NAMESPACE_UNBOUND` in
 * `src-tauri/src/companion_api/security_store.rs`; the three must agree, which
 * is what the co-located test pins.
 */

/**
 * Namespace for a pairing that predates — or precedes — any account context.
 *
 * The pre-book world had exactly one pairing and no account concept, and the
 * mobile pair screen can still complete before an account is activated. Those
 * pairings are filed here rather than dropped or guessed onto someone's
 * account; the first account activation adopts the bucket.
 */
export const DEFAULT_ACCOUNT_NAMESPACE = "__local__"
