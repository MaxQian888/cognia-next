/**
 * Minimal type declaration for `marked@4`, which ships no `.d.ts` resolvable via
 * its package exports. The TUI tokenizer only uses the block lexer; the result
 * is cast to the local `BlockToken[]` shape in `markdown/tokenize.ts`.
 */
declare module "marked" {
  export function lexer(src: string): unknown[]
}
