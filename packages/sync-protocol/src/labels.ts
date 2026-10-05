/**
 * Domain separation (protocol §1–2). Every hash, signature and HKDF `info`
 * covers `utf8("cognia-sync/v1/<label>") ‖ 0x00 ‖ bytes`, so a value made for
 * one purpose can never be replayed as another.
 */

import { concatBytes, utf8 } from "./bytes"

export const PROTOCOL_VERSION = 1

export const LABEL_PREFIX = "cognia-sync/v1/"

export type Label =
  | "space"
  | "entry"
  | "entry-hash"
  | "enroll-request"
  | "device-proof"
  | "epoch-envelope"
  | "request-name"
  | "sas-commit"
  | "sas"
  | "sas-digits"
  | "commit"
  | "chain"
  | "name"
  | "recovery"
  | "recovery-enc"
  | "recovery-sign"

const SEPARATOR = new Uint8Array([0])

export function labelled(label: Label, data: Uint8Array = new Uint8Array()): Uint8Array {
  return concatBytes(utf8(`${LABEL_PREFIX}${label}`), SEPARATOR, data)
}
