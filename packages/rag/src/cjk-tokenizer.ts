/**
 * CJK Tokenizer — Chinese, Japanese, Korean Language Support
 *
 * Provides multilingual tokenization for BM25 keyword search and
 * query processing. CJK languages don't use spaces between words,
 * so standard whitespace tokenization fails. This module uses
 * character bigram tokenization as an effective approximation.
 *
 * Strategies:
 * - Character bigram tokenization for CJK text
 * - Hybrid tokenization for mixed CJK + Latin text
 * - CJK-aware stop word filtering
 */

// ---------------------------------------------------------------------------
// CJK Detection
// ---------------------------------------------------------------------------

/** Unicode ranges for CJK characters */
const CJK_RANGES = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs (Chinese, Japanese Kanji, Korean Hanja)
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0xac00, 0xd7af], // Hangul Syllables (Korean)
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0xff00, 0xffef], // Fullwidth Forms
  [0x20000, 0x2a6df], // CJK Unified Ideographs Extension B
] as const

/**
 * Check if a character code point is a CJK character.
 */
export function isCJKChar(codePoint: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/**
 * Check if text contains significant CJK content.
 * Returns true if more than 10% of characters are CJK.
 */
export function isCJKText(text: string): boolean {
  if (!text) return false
  let cjkCount = 0
  let totalCount = 0
  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    if (cp > 0x20) {
      totalCount++
      if (isCJKChar(cp)) cjkCount++
    }
  }
  return totalCount > 0 && cjkCount / totalCount > 0.1
}

/**
 * Detect the primary CJK language of text.
 */
export function detectCJKLanguage(
  text: string
): "chinese" | "japanese" | "korean" | "mixed" | "none" {
  if (!text) return "none"

  let chinese = 0
  let hiragana = 0
  let katakana = 0
  let hangul = 0

  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    if (cp >= 0x4e00 && cp <= 0x9fff) chinese++
    if (cp >= 0x3040 && cp <= 0x309f) hiragana++
    if (cp >= 0x30a0 && cp <= 0x30ff) katakana++
    if (cp >= 0xac00 && cp <= 0xd7af) hangul++
  }

  const japanese = hiragana + katakana
  const total = chinese + japanese + hangul
  if (total === 0) return "none"

  if (hangul > total * 0.3) return "korean"
  if (japanese > total * 0.1) return "japanese"
  if (chinese > 0) return "chinese"
  return "mixed"
}

// ---------------------------------------------------------------------------
// CJK Stop Words
// ---------------------------------------------------------------------------

/** Common Chinese stop words / particles */
export const CHINESE_STOP_WORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "么",
  "为",
  "什么",
  "吗",
  "与",
  "或",
  "及",
  "但",
  "而",
  "如果",
  "因为",
  "所以",
  "从",
  "对",
  "把",
  "被",
  "让",
  "给",
  "用",
  "向",
  "以",
  "比",
  "等",
  "啊",
  "呢",
  "吧",
])

/** Common Japanese stop words / particles */
export const JAPANESE_STOP_WORDS = new Set([
  "の",
  "に",
  "は",
  "を",
  "た",
  "が",
  "で",
  "て",
  "と",
  "し",
  "れ",
  "さ",
  "ある",
  "いる",
  "も",
  "する",
  "から",
  "な",
  "こと",
  "として",
  "い",
  "や",
  "など",
  "まで",
  "ない",
  "この",
  "ため",
  "その",
  "あと",
  "もの",
  "それ",
  "よう",
  "です",
  "ます",
])

/** Common Korean stop words / particles */
export const KOREAN_STOP_WORDS = new Set([
  "이",
  "그",
  "저",
  "것",
  "수",
  "등",
  "들",
  "및",
  "에",
  "의",
  "가",
  "를",
  "은",
  "는",
  "로",
  "으로",
  "와",
  "과",
  "도",
  "를",
  "에서",
  "까지",
  "부터",
  "만",
  "이다",
  "있다",
  "하다",
  "되다",
])

/** All CJK stop words combined */
export const CJK_STOP_WORDS = new Set([
  ...CHINESE_STOP_WORDS,
  ...JAPANESE_STOP_WORDS,
  ...KOREAN_STOP_WORDS,
])

// ---------------------------------------------------------------------------
// CJK Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize CJK text using character bigrams.
 * This is a widely-used approximation for CJK languages that lack word boundaries.
 *
 * Example: "机器学习" → ["机器", "器学", "学习"]
 */
export function tokenizeCJK(text: string): string[] {
  const tokens: string[] = []
  const chars: string[] = []

  // Extract CJK character sequences
  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp !== undefined && isCJKChar(cp)) {
      chars.push(char)
    } else {
      // Process accumulated CJK chars as bigrams
      if (chars.length > 0) {
        if (chars.length === 1) {
          tokens.push(chars[0])
        } else {
          for (let i = 0; i < chars.length - 1; i++) {
            tokens.push(chars[i] + chars[i + 1])
          }
        }
        chars.length = 0
      }
    }
  }

  // Process remaining CJK chars
  if (chars.length === 1) {
    tokens.push(chars[0])
  } else if (chars.length > 1) {
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.push(chars[i] + chars[i + 1])
    }
  }

  return tokens
}

/**
 * Tokenize Latin/ASCII text using whitespace splitting.
 */
function tokenizeLatin(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

/**
 * Multilingual tokenizer that handles both CJK and Latin text.
 * Automatically detects language and applies appropriate tokenization.
 */
export function tokenizeMultilingual(text: string): string[] {
  if (!text) return []

  const tokens: string[] = []
  let latinBuffer = ""

  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp !== undefined && isCJKChar(cp)) {
      // Flush Latin buffer
      if (latinBuffer) {
        tokens.push(...tokenizeLatin(latinBuffer))
        latinBuffer = ""
      }
    } else {
      latinBuffer += char
    }
  }

  // Flush remaining Latin buffer
  if (latinBuffer) {
    tokens.push(...tokenizeLatin(latinBuffer))
  }

  // Add CJK bigrams
  tokens.push(...tokenizeCJK(text))

  // Filter stop words
  return tokens.filter((t) => !CJK_STOP_WORDS.has(t) && t.length > 0)
}

/**
 * Estimate token count for CJK-aware text.
 * CJK characters are roughly 1.5 tokens each (due to multi-byte encoding),
 * while Latin words average about 1.3 tokens.
 */
export function estimateCJKTokenCount(text: string): number {
  let cjkChars = 0
  let latinChars = 0

  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp !== undefined && isCJKChar(cp)) {
      cjkChars++
    } else if (cp !== undefined && cp > 0x20) {
      latinChars++
    }
  }

  // CJK: ~1.5 tokens per character, Latin: ~4 chars per token
  return Math.ceil(cjkChars * 1.5 + latinChars / 4)
}
