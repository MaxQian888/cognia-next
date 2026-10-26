---
"cognia-next": minor
---

Web search and page reading are now configured separately. A new Reading section picks which readers may fetch a page (direct, original-site readers, Jina, FxTwitter, or a Tavily/Exa/DeepSeek/TinyFish reader that uses your existing search key), whether paid readers may act as fallback, and whether pages must be distilled; each reader has its own connection test. DeepSeek, TinyFish and self-hosted SearXNG search are available as opt-in providers. Specialized search types and engines are no longer silently downgraded, strict safe search can't be relaxed by the agent, blocked domains are filtered from images and answers as well as results, and every search and read now runs under one time budget that stops when you cancel. Bing is marked retired and Google Custom Search as legacy.
