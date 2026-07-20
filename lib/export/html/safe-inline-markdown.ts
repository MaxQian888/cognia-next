const TOKEN_PREFIX = "\u0000cognia-inline-"

/** Render safe inline Markdown links/images plus conservative bare URL links. */
export function renderSafeInlineMarkdown(escapedText: string): string {
  const tokens: string[] = []
  const token = (html: string) => {
    const key = `${TOKEN_PREFIX}${tokens.length}\u0000`
    tokens.push(html)
    return key
  }

  let output = tokenizeMarkdownLinks(escapedText, token)
  output = tokenizeBareUrls(output, token)
  output = output
    .replace(/`([^`]+)`/g, (_match, content: string) => `<code>${content}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^_])__([^_\n]+)__/g, "$1<strong>$2</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")

  return output.replace(new RegExp(`${TOKEN_PREFIX}(\\d+)\\u0000`, "g"), (_match, index) => {
    return tokens[Number(index)] ?? ""
  })
}

function tokenizeMarkdownLinks(input: string, token: (html: string) => string): string {
  let output = ""
  let index = 0
  while (index < input.length) {
    const image = input.startsWith("![", index)
    if (!image && input[index] !== "[") {
      output += input[index]
      index += 1
      continue
    }

    const labelStart = index + (image ? 2 : 1)
    const labelEnd = findUnescaped(input, "]", labelStart)
    if (labelEnd < 0 || input[labelEnd + 1] !== "(") {
      output += input[index]
      index += 1
      continue
    }
    const destinationEnd = findBalancedDestination(input, labelEnd + 2)
    if (destinationEnd < 0) {
      output += input[index]
      index += 1
      continue
    }

    const label = input.slice(labelStart, labelEnd)
    const href = input.slice(labelEnd + 2, destinationEnd).trim()
    if (!isSafeDestination(href, image)) {
      output += input.slice(index, destinationEnd + 1)
      index = destinationEnd + 1
      continue
    }
    output += token(
      image
        ? `<img src="${href}" alt="${stripInlineMarkup(label)}" loading="lazy">`
        : `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
    )
    index = destinationEnd + 1
  }
  return output
}

function tokenizeBareUrls(input: string, token: (html: string) => string): string {
  return input.replace(/https?:\/\/[^\s<>"']+/g, (candidate) => {
    const { url, suffix } = trimUrlSuffix(candidate)
    return `${token(`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`)}${suffix}`
  })
}

function trimUrlSuffix(candidate: string): { url: string; suffix: string } {
  let url = candidate
  let suffix = ""
  while (/[.,!?;:]$/.test(url)) {
    suffix = url.slice(-1) + suffix
    url = url.slice(0, -1)
  }
  while (url.endsWith(")") && count(url, ")") > count(url, "(")) {
    suffix = ")" + suffix
    url = url.slice(0, -1)
  }
  return { url, suffix }
}

function findUnescaped(input: string, target: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === target && input[index - 1] !== "\\") return index
  }
  return -1
}

function findBalancedDestination(input: string, start: number): number {
  let depth = 1
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1
      continue
    }
    if (input[index] === "(") depth += 1
    if (input[index] === ")") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function isSafeDestination(href: string, image: boolean): boolean {
  const lower = href.toLowerCase()
  if (/^(https?:|mailto:)/.test(lower)) return true
  return image && lower.startsWith("data:image/")
}

function stripInlineMarkup(value: string): string {
  return value.replace(/[*_`]/g, "")
}

function count(value: string, character: string): number {
  return [...value].filter((item) => item === character).length
}
