export function parseSiteEnvironmentInput(value: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [index, raw] of value.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) throw new Error(`invalid environment entry on line ${index + 1}`)
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment key on line ${index + 1}`)
    }
    if (Object.hasOwn(output, key)) throw new Error(`duplicate environment key: ${key}`)
    output[key] = line.slice(separator + 1)
  }
  return output
}
