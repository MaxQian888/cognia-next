// Strip ANSI escape sequences (SGR colors, cursor moves, OSC hyperlinks) from
// raw PTY output so the console view renders plain text. Strix uses `rich`,
// which emits heavy CSI color codes and occasional OSC-8 hyperlinks.
//
// The escape/BEL bytes are built via String.fromCharCode so this source stays
// pure ASCII (embedding literal control characters is fragile).

const ESC = String.fromCharCode(27) // \x1B
const BEL = String.fromCharCode(7) // \x07

// CSI (ECMA-48): ESC [ , params (0x30-0x3F), intermediates (0x20-0x2F), final (0x40-0x7E).
const CSI_RE = new RegExp(ESC + "\\[[0-?]*[ -/]*[@-~]", "g")
// OSC: ESC ] ... terminated by BEL or ST (ESC \).
const OSC_RE = new RegExp(ESC + "\\][\\s\\S]*?(?:" + BEL + "|" + ESC + "\\\\)", "g")

export function stripAnsi(input: string): string {
  return input.replace(OSC_RE, "").replace(CSI_RE, "")
}
