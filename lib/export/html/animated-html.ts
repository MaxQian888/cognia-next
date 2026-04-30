// "Animated" HTML export — same content as the beautiful export, but messages
// fade and slide in on load and assistant text types out character-by-character.
// One self-contained `<script>` block; no runtime dependencies.

import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import { exportToBeautifulHtml, type BeautifulHtmlOptions } from "./beautiful-html"

export interface AnimatedHtmlOptions extends BeautifulHtmlOptions {
  /** Milliseconds per character for the typing effect. Default 12. */
  typingSpeedMs?: number
}

export function exportToAnimatedHtml(options: AnimatedHtmlOptions): string {
  const speed = options.typingSpeedMs ?? 12
  const baseHtml = exportToBeautifulHtml(options)
  // Inject the animation script + extra CSS just before </body>.
  const script = `
<style>
.message { opacity: 0; transform: translateY(8px); transition: opacity 0.4s ease-out, transform 0.4s ease-out; }
.message.show { opacity: 1; transform: translateY(0); }
.text-typing::after { content: '▍'; animation: blink 1s steps(2) infinite; color: currentColor; }
@keyframes blink { 50% { opacity: 0; } }
</style>
<script>
(() => {
  const messages = Array.from(document.querySelectorAll('.message'));
  let idx = 0;

  async function reveal(message) {
    return new Promise(r => {
      requestAnimationFrame(() => {
        message.classList.add('show');
        setTimeout(r, 420);
      });
    });
  }

  async function typeAssistantText(message) {
    if (!message.classList.contains('message-assistant')) return;
    const blocks = message.querySelectorAll('.text');
    for (const block of blocks) {
      const full = block.textContent;
      block.textContent = '';
      block.classList.add('text-typing');
      for (let i = 0; i < full.length; i++) {
        block.textContent += full[i];
        await new Promise(r => setTimeout(r, ${speed}));
      }
      block.classList.remove('text-typing');
    }
  }

  async function play() {
    for (const message of messages) {
      await reveal(message);
      await typeAssistantText(message);
      await new Promise(r => setTimeout(r, 80));
      idx++;
    }
  }

  // Skip-to-end on click anywhere
  document.addEventListener('click', () => {
    document.querySelectorAll('.message').forEach(m => m.classList.add('show'));
    document.querySelectorAll('.text-typing').forEach(b => {
      b.classList.remove('text-typing');
    });
  });

  // Kick off after first paint.
  requestAnimationFrame(play);
})();
</script>
`
  return baseHtml.replace("</body>", `${script}</body>`)
}

export type { ChatSession, StoredMessage }
