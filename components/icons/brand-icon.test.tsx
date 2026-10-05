import { render, screen } from "@testing-library/react"

import { BrandIcon, brandIconAsset, hasBrandIcon } from "./brand-icon"
import { RUNTIME_OPTIONS } from "@/components/agent/workspace/runtime-options"
import type { TeammateRuntime } from "@/types/agent/agent-team"

describe("BrandIcon", () => {
  it("renders the Claude Code brand asset for a known external-agent id", () => {
    render(<BrandIcon id="claude-code" label="Claude Code" decorative={false} />)

    expect(screen.getByRole("img", { name: "Claude Code" })).toHaveAttribute(
      "src",
      "/icons/lobe/claudecode-color.svg"
    )
  })

  it.each(["codex", "codex-acp", "codex-app-server"])(
    "renders the Codex asset for %s",
    (runtime) => {
      render(<BrandIcon id={runtime} label="Codex" decorative={false} />)
      expect(screen.getByRole("img", { name: "Codex" })).toHaveAttribute(
        "src",
        "/icons/lobe/codex-color.svg"
      )
    }
  )

  it("normalizes provider aliases to the same brand asset", () => {
    const { rerender } = render(
      <BrandIcon id="togetherai" label="Together AI" decorative={false} />
    )
    expect(screen.getByRole("img", { name: "Together AI" })).toHaveAttribute(
      "src",
      "/icons/lobe/together-color.svg"
    )

    rerender(<BrandIcon id="together-ai" label="Together AI" decorative={false} />)
    expect(screen.getByRole("img", { name: "Together AI" })).toHaveAttribute(
      "src",
      "/icons/lobe/together-color.svg"
    )
  })

  it("renders the SiliconFlow brand asset used by the live provider catalog", () => {
    render(<BrandIcon id="siliconflow" label="SiliconFlow" decorative={false} />)

    expect(screen.getByRole("img", { name: "SiliconFlow" })).toHaveAttribute(
      "src",
      "/icons/lobe/siliconcloud-color.svg"
    )
  })

  it.each([
    ["azure", "Azure OpenAI", "/icons/lobe/azureai-color.svg"],
    ["bedrock", "Amazon Bedrock", "/icons/lobe/bedrock-color.svg"],
    ["nvidia", "NVIDIA NIM", "/icons/lobe/nvidia-color.svg"],
    ["huggingface", "Hugging Face", "/icons/lobe/huggingface-color.svg"],
    ["perplexity", "Perplexity", "/icons/lobe/perplexity-color.svg"],
    ["deepinfra", "DeepInfra", "/icons/lobe/deepinfra-color.svg"],
    ["replicate", "Replicate", "/icons/lobe/replicate.svg"],
    ["cloudflare", "Cloudflare", "/icons/lobe/cloudflare-color.svg"],
    ["github", "GitHub Models", "/icons/lobe/github.svg"],
    ["ai21", "AI21 Labs", "/icons/lobe/ai21-brand-color.svg"],
    ["lepton", "Lepton AI", "/icons/lobe/leptonai-color.svg"],
    ["novita", "Novita AI", "/icons/lobe/novita-color.svg"],
    ["voyage", "Voyage AI", "/icons/lobe/voyage-color.svg"],
    ["jina", "Jina AI", "/icons/lobe/jina.svg"],
    ["fal", "fal", "/icons/lobe/fal-color.svg"],
  ])("renders the additional global provider asset for %s", (id, label, src) => {
    render(<BrandIcon id={id} label={label} decorative={false} />)

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("src", src)
  })

  it.each([
    ["moonshot", "Moonshot AI", "/icons/lobe/moonshot.svg"],
    ["kimi-anthropic", "Kimi", "/icons/lobe/kimi-color.svg"],
    ["kimi-coding", "Kimi Coding", "/icons/lobe/kimi-color.svg"],
    ["doubao", "Doubao", "/icons/lobe/doubao-color.svg"],
    ["baichuan", "Baichuan", "/icons/lobe/baichuan-color.svg"],
    ["lingyi", "01.AI", "/icons/lobe/yi-color.svg"],
    ["yi", "Yi", "/icons/lobe/yi-color.svg"],
    ["stepfun", "StepFun", "/icons/lobe/stepfun-color.svg"],
    ["stepfun-anthropic", "StepFun Claude", "/icons/lobe/stepfun-color.svg"],
    ["volcengine", "Volcengine", "/icons/lobe/volcengine-color.svg"],
    ["volcengine-agentplan", "Volcengine Agent Plan", "/icons/lobe/volcengine-color.svg"],
    ["internlm", "InternLM", "/icons/lobe/internlm-color.svg"],
    ["glm4", "GLM-4", "/icons/lobe/zhipu-color.svg"],
    ["baidu", "Baidu", "/icons/lobe/baidu-color.svg"],
    ["qianfan-coding", "Qianfan Coding", "/icons/lobe/baidu-color.svg"],
    ["tencent", "Tencent", "/icons/lobe/tencentcloud-color.svg"],
    ["modelscope", "ModelScope", "/icons/lobe/modelscope-color.svg"],
    ["modelscope-anthropic", "ModelScope Claude", "/icons/lobe/modelscope-color.svg"],
    ["qiniu-anthropic", "Qiniu Claude", "/icons/lobe/qiniu-color.svg"],
    ["xiaomi-mimo-anthropic", "Xiaomi MiMo", "/icons/lobe/xiaomimimo.svg"],
    ["longcat-anthropic", "LongCat", "/icons/lobe/longcat-color.svg"],
    ["bailian-anthropic", "Bailian", "/icons/lobe/bailian-color.svg"],
  ])("renders the additional China provider asset for %s", (id, label, src) => {
    render(<BrandIcon id={id} label={label} decorative={false} />)

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("src", src)
  })

  it.each([
    ["windsurf", "Windsurf", "/icons/lobe/windsurf.svg"],
    ["trae", "Trae", "/icons/lobe/trae-color.svg"],
    ["roo-code", "Roo Code", "/icons/lobe/roocode.svg"],
    ["openhands", "OpenHands", "/icons/lobe/openhands-color.svg"],
    ["devin", "Devin", "/icons/lobe/devin-color.svg"],
    ["goose", "Goose", "/icons/lobe/goose.svg"],
    ["replit", "Replit", "/icons/lobe/replit-color.svg"],
    ["amp", "Amp", "/icons/lobe/amp-color.svg"],
    ["antigravity", "Antigravity", "/icons/lobe/antigravity-color.svg"],
    ["manus", "Manus", "/icons/lobe/manus.svg"],
    ["kimi", "Kimi", "/icons/lobe/kimi-color.svg"],
    ["qoder", "Qoder", "/icons/lobe/qoder-color.svg"],
  ])("renders the optional coding-agent asset for %s", (id, label, src) => {
    render(<BrandIcon id={id} label={label} decorative={false} />)

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("src", src)
  })

  it.each([
    ["kimi", "/icons/lobe/kimi-color.svg"],
    ["qoder", "/icons/lobe/qoder-color.svg"],
  ])("preserves the colour mark for runtime %s", (runtime, src) => {
    expect(brandIconAsset(runtime)).toEqual({ src, mono: false })
  })

  it.each([
    ["tavily", "Tavily", "/icons/lobe/tavily-color.svg"],
    ["exa", "Exa", "/icons/lobe/exa-color.svg"],
    ["searchapi", "SearchAPI", "/icons/lobe/searchapi.svg"],
    ["bing", "Bing", "/icons/lobe/bing-color.svg"],
    ["brave", "Brave Search", "/icons/lobe/brave-color.svg"],
    ["google-ai", "Google AI", "/icons/lobe/google-color.svg"],
  ])("renders the Web Search provider asset for %s", (id, label, src) => {
    render(<BrandIcon id={id} label={label} decorative={false} />)

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("src", src)
  })

  it.each([
    ["mistral-ocr", "Mistral OCR", "/icons/lobe/mistral-color.svg"],
    ["google-vision", "Google Cloud Vision", "/icons/lobe/googlecloud-color.svg"],
    ["aws-textract", "Amazon Textract", "/icons/lobe/aws-color.svg"],
    ["azure-document-intelligence", "Azure Document Intelligence", "/icons/lobe/azure-color.svg"],
    ["anthropic-vision", "Anthropic Vision", "/icons/lobe/anthropic.svg"],
    ["openai-vision", "OpenAI Vision", "/icons/lobe/openai.svg"],
    ["gemini-vision", "Gemini Vision", "/icons/lobe/gemini-color.svg"],
    ["apple-vision", "Apple Vision", "/icons/lobe/apple.svg"],
    ["windows-media-ocr", "Windows Media OCR", "/icons/lobe/microsoft-color.svg"],
    ["mlkit-android", "ML Kit", "/icons/lobe/google-color.svg"],
  ])("renders the OCR provider asset for %s", (id, label, src) => {
    render(<BrandIcon id={id} label={label} decorative={false} />)

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("src", src)
  })

  it("renders a labelled monogram when the brand is unknown", () => {
    render(<BrandIcon id="custom-runtime" label="Custom runtime" decorative={false} />)

    expect(screen.getByRole("img", { name: "Custom runtime" })).toHaveTextContent("C")
  })

  it("keeps a known brand decorative by default", () => {
    const { container } = render(<BrandIcon id="openai" />)

    expect(container.querySelector("img")).toHaveAttribute("alt", "")
    expect(container.querySelector("img")).toHaveAttribute("aria-hidden", "true")
  })

  it("keeps an unknown-brand monogram decorative by default", () => {
    const { container } = render(<BrandIcon id="custom-runtime" />)

    expect(container.querySelector("span")).toHaveAttribute("aria-hidden", "true")
    expect(container.querySelector("span")).not.toHaveAttribute("aria-label")
  })

  // The sign-in screen (`components/account/cloud-sign-in-screen.tsx`) marks
  // each provider button with these.
  it.each([
    ["feishu", "/icons/brands/feishu-color.svg"],
    ["feishu-web", "/icons/brands/feishu-color.svg"],
    ["lark", "/icons/brands/feishu-color.svg"],
    ["github", "/icons/lobe/github.svg"],
    ["google", "/icons/lobe/google-color.svg"],
    ["apple", "/icons/lobe/apple.svg"],
    ["microsoft", "/icons/lobe/microsoft-color.svg"],
  ])("resolves the sign-in provider %s", (provider, src) => {
    expect(brandIconAsset(provider)).toEqual({ src, mono: !src.includes("-color") })
  })

  it("reports whether a normalized id has a brand asset", () => {
    expect(hasBrandIcon("Claude Code")).toBe(true)
    expect(hasBrandIcon("opencode-go")).toBe(true)
    expect(hasBrandIcon("glm-anthropic-intl")).toBe(true)
    expect(hasBrandIcon("custom-runtime")).toBe(false)
  })

  it("uses an explicit fallback value for an unknown brand", () => {
    render(
      <BrandIcon id="custom-runtime" label="Custom runtime" fallback="Zed" decorative={false} />
    )

    expect(screen.getByRole("img", { name: "Custom runtime" })).toHaveTextContent("Z")
  })

  it("uses a question mark when the fallback has no letters or numbers", () => {
    render(<BrandIcon id="---" label="---" decorative={false} />)

    expect(screen.getByRole("img", { name: "---" })).toHaveTextContent("?")
  })

  // Every selectable teammate runtime is rendered through `BrandIcon` by
  // `RuntimeBadge`, the runtime selector, and the mention picker. A runtime with
  // no alias silently degrades to a grey monogram, which is how `pi-rpc` shipped
  // sitting next to `pi`'s logo. Document gaps explicitly so missing vendor
  // marks keep their monograms rather than borrowing someone else's mark.
  describe("teammate runtimes resolve to a brand asset", () => {
    const NO_VENDORED_ASSET: readonly TeammateRuntime[] = [
      "droid", // No Factory asset is vendored.
      // LobeHub icons-static-svg@1.95.1 has neither aider.svg nor aider-color.svg
      // (checked 2026-10-05), so no Aider mark can be vendored from that set.
      "aider",
    ]

    it.each(NO_VENDORED_ASSET)("keeps an honest monogram for %s", (runtime) => {
      expect(hasBrandIcon(runtime)).toBe(false)
      expect(brandIconAsset(runtime)).toBeNull()
      render(<BrandIcon id={runtime} label={runtime} decorative={false} />)
      expect(screen.getByRole("img", { name: runtime })).toHaveTextContent(runtime[0].toUpperCase())
    })

    it.each(RUNTIME_OPTIONS.filter((r) => !NO_VENDORED_ASSET.includes(r)))(
      "%s has a brand alias",
      (runtime) => {
        expect(hasBrandIcon(runtime)).toBe(true)
      }
    )
  })
})
