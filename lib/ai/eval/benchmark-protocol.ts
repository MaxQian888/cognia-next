/** Small, versioned, text-only pilot. Oracles never enter model prompts. */
export type BenchmarkVariant = "single-agent" | "serial-squad" | "parallel-squad"
export interface BenchmarkCase {
  id: string
  x: string
  y: string
  expected: { x: unknown; y: unknown }
}

export function validateBenchmarkEndpoint(value: string): string {
  const endpoint = new URL(value)
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Benchmark endpoint must be an HTTP(S) URL without embedded credentials or query parameters"
    )
  return value
}
export const TEAM_BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    id: "arithmetic",
    x: "Compute 17 + 23 - 5 + 8.",
    y: "Compute 14 * 9 - 7.",
    expected: { x: 43, y: 119 },
  },
  {
    id: "sorting",
    x: "Sort [8,-2,8,3,0] in ascending order, retaining duplicates.",
    y: 'Sort the distinct strings from ["pear","apple","pear","plum"] lexicographically.',
    expected: { x: [-2, 0, 3, 8, 8], y: ["apple", "pear", "plum"] },
  },
  {
    id: "filtering",
    x: "Return all primes from [2,4,11,15,17,21], in input order.",
    y: "Sum only the even integers in [3,10,-4,7,8].",
    expected: { x: [2, 11, 17], y: 14 },
  },
  {
    id: "invoice",
    x: "Find total price for items [{price:7,quantity:3},{price:12,quantity:2}].",
    y: "Return missing IDs between 1 and 7 inclusive from the present IDs [1,2,4,7].",
    expected: { x: 45, y: [3, 5, 6] },
  },
  {
    id: "logic",
    x: "Evaluate (true AND false) OR (NOT false) as a JSON boolean.",
    y: 'Return the palindromes from ["level","test","radar","agent"], in input order.',
    expected: { x: true, y: ["level", "radar"] },
  },
  {
    id: "text",
    x: 'Count vowels (a,e,i,o,u) in "orchestration".',
    y: 'Count occurrences of each word in "one two two three"; return a JSON object.',
    expected: { x: 5, y: { one: 1, two: 2, three: 1 } },
  },
  {
    id: "graph",
    x: "Find the shortest directed path distance A->D for edges A->B=2,A->C=6,B->C=1,C->D=2,B->D=9.",
    y: 'Give the lexicographically smallest topological order for vertices ["A","B","C","D"] with edges A->C,B->C,C->D.',
    expected: { x: 5, y: ["A", "B", "C", "D"] },
  },
  {
    id: "intervals",
    x: "Merge overlapping closed intervals [[1,3],[2,5],[8,10],[9,12]], returning ascending intervals.",
    y: "Find the intersection of inclusive integer intervals [3,9] and [7,12], represented as [start,end].",
    expected: {
      x: [
        [1, 5],
        [8, 12],
      ],
      y: [7, 9],
    },
  },
  {
    id: "representation",
    x: "Convert hexadecimal 2F to an integer.",
    y: "Convert binary 101101 to an integer.",
    expected: { x: 47, y: 45 },
  },
  {
    id: "selection",
    x: "For pairs [[3,5],[7,2],[4,6]], return the maximum product of the two values in any pair.",
    y: "Return the median of [9,1,8,3,7].",
    expected: { x: 24, y: 7 },
  },
]

export function benchmarkPrompt(item: BenchmarkCase): string {
  return `Solve both independent parts. Return only a JSON object with exactly keys x and y, no explanation.\nPart x: ${item.x}\nPart y: ${item.y}`
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => JSON.stringify(key) + ":" + stable(entry))
        .join(",") +
      "}"
    )
  return JSON.stringify(value)
}

export function checkBenchmarkOutput(item: BenchmarkCase, output: string): boolean {
  try {
    const text = output
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
    return stable(JSON.parse(text)) === stable(item.expected)
  } catch {
    return false
  }
}

/** Balanced blocks: all candidates see each task/repetition before the next. */
export function benchmarkSchedule(caseIds: readonly string[], repetitions: number, seed: number) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3)
    throw new Error("Benchmark repetitions must be 1..3")
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const result: Array<{ caseId: string; repetition: number; variant: BenchmarkVariant }> = []
  for (const caseId of caseIds)
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const variants: BenchmarkVariant[] = ["single-agent", "serial-squad", "parallel-squad"]
      for (let i = variants.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[variants[i], variants[j]] = [variants[j]!, variants[i]!]
      }
      result.push(...variants.map((variant) => ({ caseId, repetition, variant })))
    }
  return result
}

export function benchmarkPercentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[
    Math.max(0, Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1))
  ]!
}
