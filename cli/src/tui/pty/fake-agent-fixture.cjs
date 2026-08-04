const ALT_ON = "\x1b[?1049h"
const ALT_OFF = "\x1b[?1049l"
const interactive = Boolean(
  process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb"
)

if (!interactive) {
  process.stdout.write("LAYOUT scrollback\nEVENT text-delta:hello\n")
  process.exit(0)
}

process.stdout.write(`${ALT_ON}READY ${process.stdout.columns}x${process.stdout.rows}\n`)
process.stdout.write("EVENT content-part:a2ui\n")
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on("data", (chunk) => {
  if (chunk.toString().includes("\x1b[<64;")) process.stdout.write("WHEEL up\n")
})
process.stdout.on("resize", () => {
  process.stdout.write(`RESIZE ${process.stdout.columns}x${process.stdout.rows}\n`)
})
const cleanup = () => {
  process.stdout.write(`${ALT_OFF}CLEANUP\n`)
  process.exit(0)
}
process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)
setTimeout(cleanup, 2_000).unref()
