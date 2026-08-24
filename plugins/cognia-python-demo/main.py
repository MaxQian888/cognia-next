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
  * ``cognia.ctx``       — the plugin -> host RPC surface (ADR-0143): reach
                           the same ``ctx.*`` APIs a TypeScript plugin gets,
                           from sync *and* async tools

Stdlib only; no pythonDependencies, so it loads on any Python >= 3.9.
"""

import asyncio
import time

import cognia
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
    """Transform hook: tag outgoing chat payloads (dict in, dict out).

    ``onMessageSend`` is a CHAT-INTERCEPTION hook: it sees, and can rewrite,
    every outgoing message. The host therefore refuses to register any hook in
    that family unless the manifest declares ``hooks:chat-intercept`` — and the
    refusal aborts the whole Python load, not just this hook, leaving the plugin
    in ``error``. If you copy this template and do not need to see the
    conversation, drop both the permission and this hook.
    """
    if isinstance(payload, dict):
        payload.setdefault("metadata", {})["pythonDemo"] = True
    return payload


@tool(description="Log a line through the host (ctx.logger.info) and confirm the round trip.")
async def host_log(message: str = "hello from python") -> str:
    """Async tool calling the host — the natural shape for `ctx.*`.

    `cognia.ctx.<namespace>.<method>(...)` is a coroutine: it writes a
    `host_request` frame and suspends until the host answers. The host loop
    keeps serving other requests meanwhile, so a blocked tool never stalls the
    plugin.
    """
    await cognia.ctx.logger.info(message)
    return f"host logged: {message}"


@tool(description="Same host call from a synchronous tool, via ctx.run_sync.")
def host_log_sync(message: str = "hello from a sync tool") -> str:
    """Sync tools run on a worker thread, so they must bridge explicitly.

    `cognia.ctx.run_sync` blocks *this thread* on the coroutine — it refuses to
    run on the event loop, where blocking would deadlock the reader that has to
    deliver the answer.
    """
    cognia.ctx.run_sync(cognia.ctx.logger.info(message))
    return f"host logged (sync): {message}"


@tool(description="Fan out concurrent host calls to show the loop stays responsive.")
async def host_fanout(count: int = 3) -> list:
    """Concurrency is real: these calls overlap.

    RepoWiki's per-module analysis leans on exactly this — N agent turns in
    flight at once, bounded by the host's outbound gate rather than serialized
    one behind another.
    """
    count = max(1, min(int(count), 5))
    results = await asyncio.gather(
        *[cognia.ctx.logger.info(f"fanout {index}") for index in range(count)]
    )
    return [str(item) for item in results]
