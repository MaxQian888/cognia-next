import { commandResult } from "./shared.mjs"

export function assessListenerOutput(output, port) {
  const matcher = new RegExp(`TCP\\s+(\\S+:${port})\\s+\\(LISTEN\\)`, "g")
  const addresses = [...String(output).matchAll(matcher)].map((match) => match[1])
  const loopbackOnly =
    addresses.length > 0 &&
    addresses.every(
      (address) =>
        address === `127.0.0.1:${port}` ||
        address === `[::1]:${port}` ||
        address === `localhost:${port}`
    )
  return { listening: addresses.length > 0, loopbackOnly, addresses }
}

export function inspectTcpListener(port) {
  const result = commandResult("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"])
  if (!result.ok && !result.stdout) {
    return { listening: false, loopbackOnly: false, addresses: [], error: result.stderr }
  }
  return assessListenerOutput(result.stdout, port)
}
