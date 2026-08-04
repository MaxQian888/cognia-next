# qwen-vLLM timeout fallback runbook

- Check vLLM waiting queue and decode latency before changing fallback thresholds.
- Confirm fallback provider health before raising upstream timeout.
- Do not restart or scale production from the SRE Agent.
