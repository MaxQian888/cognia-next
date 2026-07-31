import readline from "node:readline"

const rl = readline.createInterface({ input: process.stdin })
process.stderr.write("stub-ready\n")
rl.on("line", (line) => {
  process.stdout.write(`${line}\n`)
  if (line === "exit") process.exit(7)
})
