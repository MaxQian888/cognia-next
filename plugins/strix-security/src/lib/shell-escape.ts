// POSIX single-quote escaping. Wrapping an argument in single quotes disables
// every shell metacharacter; an embedded single quote is emitted via the
// classic `'\''` idiom. This is the command-injection guard applied to the
// user-supplied scan target before it is written into a shell command line.
//
// (Reuse note: no shared shell-escape helper exists under lib/ — verified with
// ripgrep before adding this local util.)

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
