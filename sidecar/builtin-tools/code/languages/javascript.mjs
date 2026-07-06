// JavaScript / JSX extraction descriptor.
//
// JavaScript is parsed with the `tsx` grammar (see `EXT_TO_GRAMMAR`), which is
// a superset of plain JS + JSX. The extraction rules are therefore identical to
// the TypeScript descriptor; the TS-only node types (interface/type_alias) in
// that map simply never appear in a JS AST, so re-using it is correct, not a
// stub. We only override the advertised grammar keys.

export {
  SYMBOL_TYPES,
  CALL_TYPES,
  IMPORT_TYPES,
  nodeName,
  refineKind,
  shouldSkip,
  calleeName,
  importSource,
  baseNames,
  modifiers,
  buildSignature,
} from "./typescript.mjs"

/** JavaScript is parsed with the JSX-capable `tsx` grammar. */
export const grammarKeys = ["tsx"]
