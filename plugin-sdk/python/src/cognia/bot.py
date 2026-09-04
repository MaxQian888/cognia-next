"""Bot authoring for Python plugins.

:func:`define_bot` builds the ``manifest.bots[]`` entry. A Bot is declared,
never registered through a callback: a registration function would hand the
host a Python closure, which does not survive the stdio boundary, so the
TypeScript author would get a capability the Python author could not have.

A ``executor="handler"`` Bot is backed by a ``@cognia.contribution("<bot id>")``
object whose ``run`` method the host dispatches into this process::

    import cognia
    from cognia.bot import define_bot

    DIGEST = define_bot(
        id="daily-digest",
        name="Daily digest",
        version="1.0.0",
        executor="handler",
        triggers=[{"id": "morning", "kind": "schedule", "cron": "0 9 * * 1-5"}],
    )

    @cognia.contribution("daily-digest")
    class DailyDigest:
        async def run(self, snapshot):
            ...

``run`` receives the serialisable half of the run (``runId``,
``installationId``, ``botId``, ``event``, ``config``). The durable-step surface
it drives, ``ctx.bots``, arrives with the Bot runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

#: Executor discriminants, mirroring ``PLUGIN_BOT_EXECUTORS``.
BOT_EXECUTORS = ("workflow", "squad", "agent-turn", "handler")
#: Trigger discriminants, mirroring ``PLUGIN_BOT_TRIGGER_KINDS``.
BOT_TRIGGER_KINDS = ("interaction", "event", "schedule", "poll", "derivedState", "manual")
#: Event sources a ``kind: "event"`` trigger may name.
BOT_EVENT_SOURCES = ("integration", "workflow", "connector", "desktop", "bot")

#: The executor-specific field each discriminant requires. ``handler`` is absent
#: because a Python-backed handler declares no ``entry``: the host dispatches
#: into this process instead.
_EXECUTOR_REQUIRED_FIELD = {
    "workflow": "workflow",
    "squad": "team",
    "agent-turn": "prompt",
}


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")


def _validate_trigger(trigger: Mapping[str, Any], index: int) -> Dict[str, Any]:
    label = f"bot trigger #{index}"
    trigger_id = trigger.get("id")
    if not isinstance(trigger_id, str) or not trigger_id.strip():
        raise ValueError(f"{label} must have a non-empty 'id'")
    kind = trigger.get("kind")
    if kind not in BOT_TRIGGER_KINDS:
        raise ValueError(
            f"{label} has unknown kind {kind!r}; expected one of {list(BOT_TRIGGER_KINDS)}"
        )
    if kind == "event":
        if trigger.get("source") not in BOT_EVENT_SOURCES:
            raise ValueError(
                f"{label} (event) needs a 'source' from {list(BOT_EVENT_SOURCES)}"
            )
        types = trigger.get("types")
        if not isinstance(types, (list, tuple)) or not types:
            raise ValueError(f"{label} (event) needs a non-empty 'types' list")
    if kind == "schedule" and not trigger.get("cron"):
        raise ValueError(f"{label} (schedule) needs a 'cron' expression")
    if kind in ("poll", "derivedState") and not isinstance(trigger.get("everyMs"), int):
        raise ValueError(f"{label} ({kind}) needs an integer 'everyMs'")
    if kind == "derivedState" and not trigger.get("state"):
        raise ValueError(f"{label} (derivedState) needs a 'state' name")
    return dict(trigger)


@dataclass(frozen=True)
class Bot:
    """A Bot contribution (mirrors ``PluginBotDef``)."""

    id: str
    name: str
    version: str
    executor: str
    triggers: List[Dict[str, Any]]
    description: Optional[str] = None
    icon: Optional[str] = None
    character: Optional[str] = None
    workflow: Optional[str] = None
    team: Optional[str] = None
    prompt: Optional[str] = None
    entry: Optional[str] = None
    export: Optional[str] = None
    backend: Optional[str] = None
    composition: Dict[str, Any] = field(default_factory=dict)
    requires: Dict[str, Any] = field(default_factory=dict)
    policy: Dict[str, Any] = field(default_factory=dict)
    config_schema: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "executor": self.executor,
            "triggers": [dict(t) for t in self.triggers],
        }
        for key, value in (
            ("description", self.description),
            ("icon", self.icon),
            ("character", self.character),
            ("workflow", self.workflow),
            ("team", self.team),
            ("prompt", self.prompt),
            ("entry", self.entry),
            ("export", self.export),
            ("backend", self.backend),
        ):
            if value is not None:
                out[key] = value
        for key, value in (
            ("composition", self.composition),
            ("requires", self.requires),
            ("policy", self.policy),
            ("configSchema", self.config_schema),
        ):
            if value:
                out[key] = dict(value)
        return out


def define_bot(
    id: str,
    name: str,
    version: str,
    executor: str,
    triggers: List[Mapping[str, Any]],
    *,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    character: Optional[str] = None,
    workflow: Optional[str] = None,
    team: Optional[str] = None,
    prompt: Optional[str] = None,
    entry: Optional[str] = None,
    export: Optional[str] = None,
    backend: Optional[str] = None,
    composition: Optional[Mapping[str, Any]] = None,
    requires: Optional[Mapping[str, Any]] = None,
    policy: Optional[Mapping[str, Any]] = None,
    config_schema: Optional[Mapping[str, Any]] = None,
) -> Bot:
    """Construct a validated :class:`Bot`.

    ``executor`` picks which extra field is required: ``workflow`` needs
    ``workflow``, ``squad`` needs ``team``, ``agent-turn`` needs ``prompt``, and
    ``handler`` needs nothing, because the host dispatches ``run`` into this
    process.
    """
    _require(id, "bot id")
    _require(name, "bot name")
    _require(version, "bot version")
    if executor not in BOT_EXECUTORS:
        raise ValueError(
            f"unknown bot executor {executor!r}; expected one of {list(BOT_EXECUTORS)}"
        )
    required = _EXECUTOR_REQUIRED_FIELD.get(executor)
    values = {"workflow": workflow, "team": team, "prompt": prompt}
    if required and not values.get(required):
        raise ValueError(f"bot executor {executor!r} requires a {required!r} value")
    for other, value in values.items():
        if other != required and value:
            raise ValueError(
                f"bot executor {executor!r} must not declare {other!r}"
            )
    if not triggers:
        raise ValueError("a bot needs at least one trigger, or it can never start")

    return Bot(
        id=id,
        name=name,
        version=version,
        executor=executor,
        triggers=[_validate_trigger(t, i) for i, t in enumerate(triggers)],
        description=description,
        icon=icon,
        character=character,
        workflow=workflow,
        team=team,
        prompt=prompt,
        entry=entry,
        export=export,
        backend=backend,
        composition=dict(composition or {}),
        requires=dict(requires or {}),
        policy=dict(policy or {}),
        config_schema=dict(config_schema or {}),
    )


__all__ = [
    "BOT_EVENT_SOURCES",
    "BOT_EXECUTORS",
    "BOT_TRIGGER_KINDS",
    "Bot",
    "define_bot",
]
