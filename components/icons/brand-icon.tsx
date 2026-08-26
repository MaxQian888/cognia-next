import Image from "next/image"

import { cn } from "@/lib/utils"

interface BrandAsset {
  src: string
}

const assets = {
  ai21: { src: "/icons/lobe/ai21-brand-color.svg" },
  amp: { src: "/icons/lobe/amp-color.svg" },
  antigravity: { src: "/icons/lobe/antigravity-color.svg" },
  anthropic: { src: "/icons/lobe/anthropic.svg" },
  apple: { src: "/icons/lobe/apple.svg" },
  aws: { src: "/icons/lobe/aws-color.svg" },
  azure: { src: "/icons/lobe/azureai-color.svg" },
  azurePlatform: { src: "/icons/lobe/azure-color.svg" },
  baichuan: { src: "/icons/lobe/baichuan-color.svg" },
  baidu: { src: "/icons/lobe/baidu-color.svg" },
  bailian: { src: "/icons/lobe/bailian-color.svg" },
  bedrock: { src: "/icons/lobe/bedrock-color.svg" },
  bing: { src: "/icons/lobe/bing-color.svg" },
  brave: { src: "/icons/lobe/brave-color.svg" },
  cerebras: { src: "/icons/lobe/cerebras-color.svg" },
  claude: { src: "/icons/lobe/claude-color.svg" },
  cline: { src: "/icons/lobe/cline.svg" },
  claudeCode: { src: "/icons/lobe/claudecode-color.svg" },
  codex: { src: "/icons/lobe/codex-color.svg" },
  cohere: { src: "/icons/lobe/cohere-color.svg" },
  cloudflare: { src: "/icons/lobe/cloudflare-color.svg" },
  cursor: { src: "/icons/lobe/cursor.svg" },
  deepinfra: { src: "/icons/lobe/deepinfra-color.svg" },
  deepseek: { src: "/icons/lobe/deepseek-color.svg" },
  devin: { src: "/icons/lobe/devin-color.svg" },
  doubao: { src: "/icons/lobe/doubao-color.svg" },
  exa: { src: "/icons/lobe/exa-color.svg" },
  fal: { src: "/icons/lobe/fal-color.svg" },
  fireworks: { src: "/icons/lobe/fireworks-color.svg" },
  gemini: { src: "/icons/lobe/gemini-color.svg" },
  geminiCli: { src: "/icons/lobe/geminicli-color.svg" },
  github: { src: "/icons/lobe/github.svg" },
  githubCopilot: { src: "/icons/lobe/githubcopilot.svg" },
  google: { src: "/icons/lobe/google-color.svg" },
  googleCloud: { src: "/icons/lobe/googlecloud-color.svg" },
  goose: { src: "/icons/lobe/goose.svg" },
  groq: { src: "/icons/lobe/groq.svg" },
  huggingFace: { src: "/icons/lobe/huggingface-color.svg" },
  internLm: { src: "/icons/lobe/internlm-color.svg" },
  jina: { src: "/icons/lobe/jina.svg" },
  kimi: { src: "/icons/lobe/kimi-color.svg" },
  kiro: { src: "/icons/lobe/kiro-color.svg" },
  lepton: { src: "/icons/lobe/leptonai-color.svg" },
  lmStudio: { src: "/icons/lobe/lmstudio.svg" },
  longCat: { src: "/icons/lobe/longcat-color.svg" },
  manus: { src: "/icons/lobe/manus.svg" },
  microsoft: { src: "/icons/lobe/microsoft-color.svg" },
  minimax: { src: "/icons/lobe/minimax-color.svg" },
  mistral: { src: "/icons/lobe/mistral-color.svg" },
  modelScope: { src: "/icons/lobe/modelscope-color.svg" },
  moonshot: { src: "/icons/lobe/moonshot.svg" },
  novita: { src: "/icons/lobe/novita-color.svg" },
  nvidia: { src: "/icons/lobe/nvidia-color.svg" },
  ollama: { src: "/icons/lobe/ollama.svg" },
  openHands: { src: "/icons/lobe/openhands-color.svg" },
  openai: { src: "/icons/lobe/openai.svg" },
  openCode: { src: "/icons/lobe/opencode.svg" },
  openRouter: { src: "/icons/lobe/openrouter-color.svg" },
  perplexity: { src: "/icons/lobe/perplexity-color.svg" },
  pi: { src: "/icons/lobe/pi.svg" },
  qiniu: { src: "/icons/lobe/qiniu-color.svg" },
  qwen: { src: "/icons/lobe/qwen-color.svg" },
  replicate: { src: "/icons/lobe/replicate.svg" },
  replit: { src: "/icons/lobe/replit-color.svg" },
  rooCode: { src: "/icons/lobe/roocode.svg" },
  sambaNova: { src: "/icons/lobe/sambanova-color.svg" },
  searchApi: { src: "/icons/lobe/searchapi.svg" },
  siliconFlow: { src: "/icons/lobe/siliconcloud-color.svg" },
  stepFun: { src: "/icons/lobe/stepfun-color.svg" },
  tavily: { src: "/icons/lobe/tavily-color.svg" },
  tencent: { src: "/icons/lobe/tencentcloud-color.svg" },
  together: { src: "/icons/lobe/together-color.svg" },
  trae: { src: "/icons/lobe/trae-color.svg" },
  vllm: { src: "/icons/lobe/vllm-color.svg" },
  volcengine: { src: "/icons/lobe/volcengine-color.svg" },
  voyage: { src: "/icons/lobe/voyage-color.svg" },
  windsurf: { src: "/icons/lobe/windsurf.svg" },
  xiaomiMimo: { src: "/icons/lobe/xiaomimimo.svg" },
  xai: { src: "/icons/lobe/xai.svg" },
  yi: { src: "/icons/lobe/yi-color.svg" },
  zhipu: { src: "/icons/lobe/zhipu-color.svg" },
} satisfies Record<string, BrandAsset>

const BRAND_ALIASES: Record<string, BrandAsset> = {
  ai21: assets.ai21,
  amp: assets.amp,
  antigravity: assets.antigravity,
  anthropic: assets.anthropic,
  "anthropic-vision": assets.anthropic,
  "apple-vision": assets.apple,
  "aws-textract": assets.aws,
  azure: assets.azure,
  "azure-document-intelligence": assets.azurePlatform,
  baichuan: assets.baichuan,
  baidu: assets.baidu,
  bedrock: assets.bedrock,
  bing: assets.bing,
  brave: assets.brave,
  cerebras: assets.cerebras,
  claude: assets.claude,
  cline: assets.cline,
  "claude-code": assets.claudeCode,
  claudecode: assets.claudeCode,
  codex: assets.codex,
  "codex-app-server": assets.codex,
  cohere: assets.cohere,
  cloudflare: assets.cloudflare,
  cursor: assets.cursor,
  "cursor-cli": assets.cursor,
  deepinfra: assets.deepinfra,
  deepseek: assets.deepseek,
  devin: assets.devin,
  doubao: assets.doubao,
  exa: assets.exa,
  fal: assets.fal,
  fireworks: assets.fireworks,
  "fireworks-ai": assets.fireworks,
  "gemini-cli": assets.geminiCli,
  "gemini-vision": assets.gemini,
  geminicli: assets.geminiCli,
  github: assets.github,
  "github-copilot": assets.githubCopilot,
  "copilot-cli": assets.githubCopilot,
  google: assets.google,
  "google-ai": assets.google,
  "google-vision": assets.googleCloud,
  glm4: assets.zhipu,
  goose: assets.goose,
  groq: assets.groq,
  huggingface: assets.huggingFace,
  internlm: assets.internLm,
  jina: assets.jina,
  kiro: assets.kiro,
  lingyi: assets.yi,
  lepton: assets.lepton,
  lmstudio: assets.lmStudio,
  "lm-studio": assets.lmStudio,
  minimax: assets.minimax,
  manus: assets.manus,
  "mistral-ocr": assets.mistral,
  "mlkit-android": assets.google,
  "windows-media-ocr": assets.microsoft,
  mistral: assets.mistral,
  "mistral-ai": assets.mistral,
  modelscope: assets.modelScope,
  moonshot: assets.moonshot,
  novita: assets.novita,
  nvidia: assets.nvidia,
  ollama: assets.ollama,
  openhands: assets.openHands,
  "open-hands": assets.openHands,
  openai: assets.openai,
  "openai-vision": assets.openai,
  opencode: assets.openCode,
  "opencode-go": assets.openCode,
  "opencode-acp": assets.openCode,
  "opencode-server": assets.openCode,
  "opencode-remote": assets.openCode,
  "opencode-v2-preview": assets.openCode,
  openrouter: assets.openRouter,
  "open-router": assets.openRouter,
  perplexity: assets.perplexity,
  pi: assets.pi,
  // Same product as `pi`, different transport (ADR-0119). Without this the
  // native-RPC runtime falls through to the grey letter tile in the runtime
  // badge, the runtime selector, and the mention picker — while plain `pi`
  // right beside it shows the logo.
  "pi-rpc": assets.pi,
  qiniu: assets.qiniu,
  qwen: assets.qwen,
  "qwen-code": assets.qwen,
  replicate: assets.replicate,
  replit: assets.replit,
  roocode: assets.rooCode,
  "roo-code": assets.rooCode,
  sambanova: assets.sambaNova,
  "samba-nova": assets.sambaNova,
  searchapi: assets.searchApi,
  siliconflow: assets.siliconFlow,
  stepfun: assets.stepFun,
  tavily: assets.tavily,
  tencent: assets.tencent,
  together: assets.together,
  togetherai: assets.together,
  "together-ai": assets.together,
  trae: assets.trae,
  vllm: assets.vllm,
  volcengine: assets.volcengine,
  voyage: assets.voyage,
  windsurf: assets.windsurf,
  xai: assets.xai,
  yi: assets.yi,
  zhipu: assets.zhipu,
  "zhipu-ai": assets.zhipu,
  "deepseek-anthropic": assets.deepseek,
  "bailian-anthropic": assets.bailian,
  "glm-anthropic": assets.zhipu,
  "glm-anthropic-intl": assets.zhipu,
  "kimi-anthropic": assets.kimi,
  "kimi-coding": assets.kimi,
  "longcat-anthropic": assets.longCat,
  "minimax-anthropic": assets.minimax,
  "minimax-anthropic-intl": assets.minimax,
  "modelscope-anthropic": assets.modelScope,
  "openrouter-anthropic": assets.openRouter,
  "qianfan-coding": assets.baidu,
  "qiniu-anthropic": assets.qiniu,
  "siliconflow-anthropic": assets.siliconFlow,
  "stepfun-anthropic": assets.stepFun,
  "volcengine-agentplan": assets.volcengine,
  "xiaomi-mimo-anthropic": assets.xiaomiMimo,
  "novita-anthropic": assets.novita,
}

export interface BrandIconProps {
  id: string
  className?: string
  decorative?: boolean
  fallback?: string
  label?: string
  size?: number
}

function normalizeBrandId(id: string): string {
  return id.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-")
}

export function hasBrandIcon(id: string): boolean {
  return BRAND_ALIASES[normalizeBrandId(id)] !== undefined
}

/**
 * Path to a brand mark, for the callers that cannot render a component — the
 * composer's chip overlay paints its icons as CSS backgrounds, because the
 * overlay mirrors the textarea character for character and an extra element in
 * the flow would shift every pill after it.
 *
 * `mono` reports whether the asset is a single-colour mark (the lobe set names
 * its colour variants `-color`). A monochrome mark is black and needs
 * inverting on a dark surface; a colour one must never be touched.
 */
export function brandIconAsset(id: string): { src: string; mono: boolean } | null {
  const asset = BRAND_ALIASES[normalizeBrandId(id)]
  if (!asset) return null
  return { src: asset.src, mono: !asset.src.includes("-color") }
}

function fallbackLetter(value: string): string {
  return value.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?"
}

export function BrandIcon({
  id,
  className,
  decorative = true,
  fallback,
  label,
  size = 24,
}: BrandIconProps) {
  const asset = BRAND_ALIASES[normalizeBrandId(id)]
  const accessibleLabel = label ?? id
  const style = { height: size, width: size }

  if (!asset) {
    return (
      <span
        role={decorative ? undefined : "img"}
        aria-hidden={decorative || undefined}
        aria-label={decorative ? undefined : accessibleLabel}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[0.28em] bg-muted text-[0.52em] font-semibold uppercase leading-none text-muted-foreground ring-1 ring-border/70",
          className
        )}
        style={style}
      >
        {fallbackLetter(fallback ?? accessibleLabel)}
      </span>
    )
  }

  return (
    // A white tile keeps monochrome brand marks legible in both themes while
    // preserving the vendor-provided colors for multicolor marks.
    <Image
      src={asset.src}
      alt={decorative ? "" : accessibleLabel}
      aria-hidden={decorative || undefined}
      height={size}
      width={size}
      className={cn(
        "inline-block shrink-0 rounded-[0.28em] bg-white object-contain p-[0.12em] ring-1 ring-black/10",
        className
      )}
      style={style}
    />
  )
}
