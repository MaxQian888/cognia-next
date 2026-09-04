"""Cognia hybrid plugin Python backend template.

The desktop host imports this file from the manifest's ``pythonMain`` field.
``frontend/index.js`` is activated separately and the hybrid loader coordinates
both runtimes.

Two ways in, both used by the frontend half:

* ``@tool`` registers with the agent directly. The model calls it by name and
  the JavaScript side is not involved.
* Any module-level public callable is reachable from JavaScript through
  ``ctx.python.call("<name>", ...)``. ``word_count`` below is the one the
  frontend's ``template_word_count`` tool and ``/template-wordcount`` both use,
  and it needs no decorator to be callable.
"""

from __future__ import annotations

from typing import Any

from cognia import get_config, log, tool


def on_startup() -> None:
    """Optional. Called after the host imports this module."""
    log("hybrid template backend ready")


@tool(
    name="template_echo",
    description="Echo the supplied message back to the agent from Python.",
    parameters={
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "The message to echo.",
            }
        },
        "required": ["message"],
        "additionalProperties": False,
    },
)
def template_echo(message: str) -> dict[str, Any]:
    """Return a JSON-serializable echo payload from the Python side."""

    text = message if isinstance(message, str) else str(message)
    if get_config().get("shoutEcho"):
        text = text.upper()
    log("hybrid template_echo called")
    return {"ok": True, "runtime": "python", "echoed": text}


def word_count(text: str) -> int:
    """Count words. Called from the frontend through ``ctx.python.call``.

    Public and module-level, which is the whole contract: the host refuses a
    name starting with an underscore, and a nested or imported function is not
    reachable at all.
    """

    return len(str(text or "").split())
