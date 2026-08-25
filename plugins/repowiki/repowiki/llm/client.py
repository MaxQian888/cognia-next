"""Upstream's litellm wrapper, re-pointed at the host's agent API.

Kept as a module of its own — rather than deleting it and rewriting every
import — because the analyzer, the prompts and their tests all address
``repowiki.llm.client.LLMClient``. The implementation lives in
:mod:`repowiki.host`, which is the single place that knows about ``cognia``.
"""

from __future__ import annotations

from repowiki.host import LLMClient, LLMError, split_messages

__all__ = ["LLMClient", "LLMError", "split_messages"]
