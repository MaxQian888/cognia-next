// CommonJS shim for nanoid — the published package is ESM-only and Jest's
// default transform pipeline can't parse ES module syntax in node_modules.
// We implement the same `nanoid()` / `customAlphabet()` surface using
// crypto.randomBytes so tests get realistic IDs without pulling the ESM build.

const { randomBytes } = require("crypto")

const URL_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

function nanoid(size = 21) {
  const bytes = randomBytes(size)
  let id = ""
  for (let i = 0; i < size; i++) {
    id += URL_ALPHABET[bytes[i] & 63]
  }
  return id
}

function customAlphabet(alphabet, defaultSize = 21) {
  return (size = defaultSize) => {
    const bytes = randomBytes(size)
    let id = ""
    for (let i = 0; i < size; i++) {
      id += alphabet[bytes[i] % alphabet.length]
    }
    return id
  }
}

module.exports = {
  nanoid,
  customAlphabet,
  urlAlphabet: URL_ALPHABET,
}
