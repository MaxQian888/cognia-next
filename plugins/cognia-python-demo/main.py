"""Cognia Python runtime reference plugin.

Exercises every host feature end-to-end and doubles as living
documentation for plugin authors:

  * ``@tool``            — plain tools with inferred / explicit parameters
  * generator tools      — each ``yield`` streams a chunk event to the UI
  * ``cognia.progress``  — progress frames for long-running work
  * ``@hook``            — host-dispatched event handlers (transform style)
  * lifecycle            — ``on_startup`` / ``on_config_updated`` /
                           ``on_shutdown`` module conventions
  * ``cognia.get_config`` — the user's persisted configSchema values

Stdlib only; no pythonDependencies, so it loads on any Python >= 3.9.
"""

import time

from cognia import get_config, hook, progress, tool


def _format(text):
    config = get_config()
    greeting = config.get("greeting") or "Hello"
    message = f"{greeting}, {text}!"
    return message.upper() if config.get("shout") else message


def on_startup():
    print(f"cognia-python-demo started with config: {get_config()}")


def on_config_updated(config):
    print(f"cognia-python-demo config updated: {config}")


def on_shutdown():
    print("cognia-python-demo shutting down")


@tool(description="Greet someone using the configured greeting.")
def greet(name: str):
    return _format(name)


@tool(description="Add two numbers.")
def add(a: float, b: float):
    return a + b


@tool(
    name="word_stats",
    description="Count words and characters in a text.",
    parameters={
        "text": {"type": "string", "required": True, "description": "Text to analyze"},
    },
)
def word_stats(text):
    words = text.split()
    return {
        "words": len(words),
        "characters": len(text),
        "longest": max(words, key=len) if words else "",
    }


@tool(description="Stream a countdown, one chunk per step, with progress.")
def countdown(start: int = 3):
    start = max(1, min(int(start), 10))
    for index in range(start, 0, -1):
        progress(pct=round((start - index + 1) / start * 100), message=f"counting {index}")
        yield f"{index}... "
        time.sleep(0.05)
    yield "liftoff!"


@hook("onMessageSend")
def stamp_outgoing(payload):
    """Transform hook: tag outgoing chat payloads (dict in, dict out)."""
    if isinstance(payload, dict):
        payload.setdefault("metadata", {})["pythonDemo"] = True
    return payload
