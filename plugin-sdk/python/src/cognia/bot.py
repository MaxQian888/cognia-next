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

``run`` receives a :class:`BotRun`: the serialisable half of the run
(``runId``, ``installationId``, ``botId``, ``event``, ``config``) plus the
durable-step surface the TypeScript ``ctx.step`` provides, driven over
``ctx.bots.*`` host calls keyed by ``runId``. The reference runtime wraps the
snapshot automatically when the contribution id matches a ``define_bot`` id;
on a host that cannot know the contribution is a Bot, wrap it by hand::

    async def run(self, snapshot):
        run = cognia.bot.bot_run(cognia.ctx, snapshot)
        async with run.step("fetch") as step:
            step.complete({"items": ...})

A wait that cannot be answered leaves the queue as ``{"status": "parked"}`` —
the host records the park itself, so :class:`BotRunParked` propagating out of
``run`` is courtesy only: the host never reads it.

Lifecycle hooks are declared on the definition (``lifecycle={"hooks": [...]}``)
and implemented as methods on the same ``@cognia.contribution`` object::

    @cognia.contribution("daily-digest")
    class DailyDigest:
        async def run(self, snapshot): ...

        async def on_install(self, ctx): ...
        async def on_configure(self, ctx): ...
        async def on_arm(self, ctx): ...
        async def on_uninstall(self, ctx): ...

The host calls the manifest's camelCase names (``onInstall`` …); the runtime
maps them onto the snake_case methods above. ``ctx`` is the serialisable
:class:`BotLifecycleContextV1` dict — an ``installation`` snapshot plus
``previousConfig`` for ``on_configure`` and ``trigger`` for ``on_arm``.
``on_install``, ``on_configure`` and ``on_arm`` may veto their mutation by
raising; ``on_uninstall`` is advisory and can never block removal. For a
Python plugin ``lifecycle.entry`` is ignored: the hooks live on the
contribution object.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import re
from typing import Any, Dict, Iterator, List, Literal, Mapping, Optional, Set, TypedDict


class BotPublicationReference(TypedDict):
    """Owned publication identity returned by ctx.bots.getInstallation.

    Callers must verify the remote branch, exact head, and task marker before
    restoring monitoring. This reference never contains a diff or credentials.
    """

    sourceRunId: str
    repository: str
    branch: str
    headSha: str
    snapshotId: str
    sourcePayload: Any


class _BotApprovalRequired(TypedDict):
    title: str


class BotApprovalRequest(_BotApprovalRequired, total=False):
    """Serialized host decision request. Omitted decisionMode retains human approval.

    ``policy`` asks the host to evaluate the installation's explicit authority;
    it never grants authority to a plugin by itself.
    """

    decisionMode: Literal["human", "policy"]
    message: str
    detail: Dict[str, Any]
    risk: Literal["low", "medium", "high"]
    timeoutMs: int

class BotRunParked(Exception):
    """A wait could not be answered, so the run must leave the queue.

    Courtesy only — the host recorded the park itself when the ``ctx.bots``
    wait call returned ``{"status": "parked"}``, and the bridge rethrows the
    recorded error once ``run`` settles. Raising this simply lets an attentive
    handler stop early instead of doing work that will be discarded.
    """

    def __init__(
        self, step_name: str, resume_at: int, waiting_for: Optional[str] = None
    ) -> None:
        self.step_name = step_name
        self.resume_at = resume_at
        self.waiting_for = waiting_for
        super().__init__(f"Bot run parked at step {step_name}")


#: ``define_bot`` ids seen by this process. ``Runtime.dispatch_contribution``
#: matches a contribution id against this set to decide whether the ``run``
#: argument is a snapshot to wrap in :class:`BotRun`.
_DEFINED_BOT_IDS: Set[str] = set()


def is_bot_contribution(contribution_id: str) -> bool:
    """Whether ``contribution_id`` names a Bot defined via :func:`define_bot`."""
    return contribution_id in _DEFINED_BOT_IDS


class _StepHolder:
    """Yielded by :meth:`BotRun.step`. ``complete`` records the step's output."""

    def __init__(self, memoized: bool, value: Any = None) -> None:
        self.memoized = memoized
        self.value = value

    def complete(self, value: Any = None) -> None:
        self.value = value


class BotRun:
    """A Bot run snapshot plus the ``ctx.bots`` durable-step surface.

    Wraps a ``BotRunSnapshot`` mapping and drives ``ctx.bots.*`` host calls
    keyed by ``runId`` — the cross-process twin of the TypeScript
    ``BotRunContextV1.step`` / ``log`` / ``progress``.
    """

    def __init__(self, ctx: Any, snapshot: Mapping[str, Any]) -> None:
        self._ctx = ctx
        self._snapshot = snapshot
        self.run_id: str = snapshot["runId"]
        self.installation_id: str = snapshot["installationId"]
        self.bot_id: str = snapshot["botId"]
        self.event: Mapping[str, Any] = snapshot["event"]
        self.config: Mapping[str, Any] = snapshot.get("config") or {}

    @staticmethod
    def _settle_or_park(outcome: Mapping[str, Any]) -> Any:
        if outcome.get("status") == "parked":
            raise BotRunParked(
                outcome["stepName"],
                outcome["resumeAt"],
                outcome.get("waitingFor"),
            )
        return outcome.get("value")

    @asynccontextmanager
    async def step(self, name: str) -> Iterator[_StepHolder]:
        """Run the body once per run, ever.

        ``stepBegin`` memoizes on the host: a re-entered handler replays the
        completed value without running the body. On a normal exit the holder's
        value is written via ``stepComplete``; on an exception the step is
        failed and the error re-raised.
        """
        begun = await self._ctx.bots.stepBegin(self.run_id, name)
        if begun.get("memoized"):
            yield _StepHolder(memoized=True, value=begun.get("value"))
            return
        holder = _StepHolder(memoized=False)
        try:
            yield holder
        except Exception as exc:
            await self._ctx.bots.stepFail(self.run_id, name, str(exc))
            raise
        await self._ctx.bots.stepComplete(self.run_id, name, holder.value)

    async def wait_for_approval(
        self, name: str, request: Mapping[str, Any]
    ) -> Dict[str, Any]:
        """Ask a human (or the installation's policy) before continuing.

        Raises :class:`BotRunParked` when nobody has answered yet.
        """
        outcome = await self._ctx.bots.waitForApproval(
            self.run_id, name, dict(request)
        )
        return self._settle_or_park(outcome)

    async def wait_for_event(
        self, name: str, key: str, timeout_ms: int
    ) -> Optional[Dict[str, Any]]:
        """Wait for a correlated event; ``None`` on timeout.

        Raises :class:`BotRunParked` while the event has not arrived.
        """
        outcome = await self._ctx.bots.waitForEvent(
            self.run_id, name, {"key": key, "timeoutMs": timeout_ms}
        )
        return self._settle_or_park(outcome)

    async def log(
        self,
        level: Literal["debug", "info", "warn", "error"],
        message: str,
        data: Optional[Mapping[str, Any]] = None,
    ) -> None:
        """Append a handler log line to the run journal."""
        if level not in ("debug", "info", "warn", "error"):
            raise ValueError(f"unknown bot log level {level!r}")
        await self._ctx.bots.log(self.run_id, level, message, data)

    async def progress(
        self, fraction: Optional[float] = None, message: Optional[str] = None
    ) -> None:
        """Report progress on the run journal."""
        update: Dict[str, Any] = {}
        if fraction is not None:
            update["fraction"] = fraction
        if message is not None:
            update["message"] = message
        await self._ctx.bots.progress(self.run_id, update)

    async def get_installation(self) -> Dict[str, Any]:
        """The installation snapshot: config, triggers, credential slots."""
        return await self._ctx.bots.getInstallation(self.run_id)

    async def write_trigger_state(
        self,
        trigger_id: str,
        cursor: Optional[str] = None,
        watermark: Optional[float] = None,
    ) -> None:
        """Merge ``cursor``/``watermark`` into a poll/derivedState trigger's state.

        Host-owned keys (edge memory, debounce) are rejected by the host.
        """
        state: Dict[str, Any] = {"triggerId": trigger_id}
        if cursor is not None:
            state["cursor"] = cursor
        if watermark is not None:
            state["watermark"] = watermark
        await self._ctx.bots.writeTriggerState(self.run_id, state)

    async def set_trigger_armed(self, trigger_id: str, armed: bool) -> None:
        """Arm or disarm a declared trigger. Does not cancel the current run."""
        await self._ctx.bots.setTriggerArmed(
            self.run_id, {"triggerId": trigger_id, "armed": bool(armed)}
        )

    async def list_deliveries(
        self,
        resource_id: Optional[str] = None,
        trigger_id: Optional[str] = None,
        status: Optional[List[str]] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Delivery summaries for this installation, newest first — no payloads."""
        query: Dict[str, Any] = {}
        if resource_id is not None:
            query["resourceId"] = resource_id
        if trigger_id is not None:
            query["triggerId"] = trigger_id
        if status is not None:
            query["status"] = list(status)
        if limit is not None:
            query["limit"] = limit
        return await self._ctx.bots.listDeliveries(self.run_id, query)

    async def get_run_result(self, run_id: str) -> Optional[Dict[str, Any]]:
        """A sibling run's result, or ``None`` when unknown or foreign-owned."""
        return await self._ctx.bots.getRunResult(self.run_id, {"runId": run_id})

    async def emit(
        self,
        type: str,
        payload: Any,
        resource: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Publish a ``<pluginId>.<dotted>`` event onto the Bot plane."""
        event: Dict[str, Any] = {"type": type, "payload": payload}
        if resource is not None:
            event["resource"] = dict(resource)
        return await self._ctx.bots.emit(self.run_id, event)


def bot_run(ctx: Any, snapshot: Mapping[str, Any]) -> BotRun:
    """Wrap a ``run`` snapshot in :class:`BotRun`.

    Only needed on a host that does not know the contribution is a Bot — the
    reference runtime's dispatcher already wraps when the contribution id
    matches a :func:`define_bot` id.
    """
    return BotRun(ctx, snapshot)


#: Executor discriminants, mirroring ``PLUGIN_BOT_EXECUTORS``.
BOT_EXECUTORS = ("workflow", "squad", "agent-turn", "handler")
#: Trigger discriminants, mirroring ``PLUGIN_BOT_TRIGGER_KINDS``.
BOT_TRIGGER_KINDS = ("interaction", "event", "schedule", "poll", "derivedState", "manual")
#: Event sources a ``kind: "event"`` trigger may name.
BOT_EVENT_SOURCES = ("integration", "workflow", "connector", "desktop", "bot")
#: Lifecycle hook names as the manifest declares them (mirrors
#: ``PLUGIN_BOT_LIFECYCLE_HOOKS``). Python authors implement the snake_case
#: equivalents; the runtime maps between the two.
BOT_LIFECYCLE_HOOKS = ("onInstall", "onConfigure", "onArm", "onUninstall")

#: camelCase host dispatch name → snake_case method a Python author writes.
BOT_LIFECYCLE_PY_METHODS = {
    "onInstall": "on_install",
    "onConfigure": "on_configure",
    "onArm": "on_arm",
    "onUninstall": "on_uninstall",
}

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


# Keep in lockstep with `validateBots` in `lib/plugin/core/validation.ts`.
TIMED_TRIGGER_MIN_EVERY_MS = 15_000

_MATCH_PATH = re.compile(r"^[A-Za-z0-9_.]+$")

_CONFIG_KEY_KINDS = {
    "cronConfigKey": ("schedule",),
    "timezoneConfigKey": ("schedule",),
    "everyMsConfigKey": ("poll", "derivedState"),
}


def _is_scalar(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool))


def _validate_trigger(
    trigger: Mapping[str, Any],
    index: int,
    config_schema: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    label = f"bot trigger #{index}"
    trigger_id = trigger.get("id")
    if not isinstance(trigger_id, str) or not trigger_id.strip():
        raise ValueError(f"{label} must have a non-empty 'id'")
    kind = trigger.get("kind")
    if kind not in BOT_TRIGGER_KINDS:
        raise ValueError(
            f"{label} has unknown kind {kind!r}; expected one of {list(BOT_TRIGGER_KINDS)}"
        )
    conditions = trigger.get("conditions")
    if conditions is not None:
        if not isinstance(conditions, Mapping):
            raise ValueError(f"{label} 'conditions' must be an object")
        match = conditions.get("match")
        if match is not None:
            if not isinstance(match, Mapping):
                raise ValueError(f"{label} 'conditions.match' must be an object")
            for path, expected in match.items():
                valid = (
                    isinstance(path, str)
                    and bool(_MATCH_PATH.match(path))
                    and (
                        _is_scalar(expected)
                        or (
                            isinstance(expected, (list, tuple))
                            and len(expected) > 0
                            and all(_is_scalar(item) for item in expected)
                        )
                    )
                )
                if not valid:
                    raise ValueError(
                        f"{label} 'conditions.match.{path}' must be a scalar or a non-empty scalar list"
                    )
    retry = trigger.get("retry")
    if retry is not None:
        if not isinstance(retry, Mapping):
            raise ValueError(f"{label} 'retry' must be an object")
        max_attempts = retry.get("maxAttempts")
        if max_attempts is not None and (
            not isinstance(max_attempts, int)
            or isinstance(max_attempts, bool)
            or not 1 <= max_attempts <= 5
        ):
            raise ValueError(f"{label} 'retry.maxAttempts' must be an integer in 1..5")
        for delay_key in ("baseDelayMs", "maxDelayMs"):
            delay = retry.get(delay_key)
            if delay is not None and (
                not isinstance(delay, int) or isinstance(delay, bool) or delay <= 0
            ):
                raise ValueError(f"{label} 'retry.{delay_key}' must be a positive integer")
        base_delay = retry.get("baseDelayMs")
        max_delay = retry.get("maxDelayMs")
        if base_delay is not None and max_delay is not None and max_delay < base_delay:
            raise ValueError(f"{label} 'retry.maxDelayMs' must be >= 'retry.baseDelayMs'")
    schema_props = (
        config_schema.get("properties") if isinstance(config_schema, Mapping) else None
    )
    for key, kinds in _CONFIG_KEY_KINDS.items():
        value = trigger.get(key)
        if value is None:
            continue
        if kind not in kinds:
            raise ValueError(
                f"{label} '{key}' is only valid on {'/'.join(kinds)} triggers"
            )
        if (
            not isinstance(value, str)
            or not value.strip()
            or not (isinstance(schema_props, Mapping) and value in schema_props)
        ):
            raise ValueError(
                f"{label} '{key}' must name a key in the bot's configSchema properties"
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
    if kind in ("poll", "derivedState"):
        every_ms = trigger.get("everyMs")
        if not isinstance(every_ms, int) or isinstance(every_ms, bool):
            raise ValueError(f"{label} ({kind}) needs an integer 'everyMs'")
        if every_ms < TIMED_TRIGGER_MIN_EVERY_MS:
            raise ValueError(
                f"{label} ({kind}) 'everyMs' must be at least {TIMED_TRIGGER_MIN_EVERY_MS}ms"
            )
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
    lifecycle: Optional[Dict[str, Any]] = None

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
        if self.lifecycle is not None:
            out["lifecycle"] = dict(self.lifecycle)
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
    lifecycle: Optional[Mapping[str, Any]] = None,
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

    lifecycle_dict: Optional[Dict[str, Any]] = None
    if lifecycle is not None:
        if not isinstance(lifecycle, Mapping):
            raise ValueError("bot 'lifecycle' must be an object")
        hooks = lifecycle.get("hooks")
        if not isinstance(hooks, (list, tuple)) or not hooks:
            raise ValueError("bot 'lifecycle.hooks' must name at least one hook")
        seen_hooks: Set[Any] = set()
        for hook in hooks:
            if hook not in BOT_LIFECYCLE_HOOKS:
                raise ValueError(
                    f"bot 'lifecycle.hooks' has unknown hook {hook!r}; "
                    f"expected one of {list(BOT_LIFECYCLE_HOOKS)}"
                )
            if hook in seen_hooks:
                raise ValueError(f"bot 'lifecycle.hooks' names {hook!r} twice")
            seen_hooks.add(hook)
        lc_entry = lifecycle.get("entry")
        if lc_entry is not None and not isinstance(lc_entry, str):
            raise ValueError("bot 'lifecycle.entry' must be a string")
        lifecycle_dict = dict(lifecycle)

    # Recorded so the dispatcher can wrap a `run` snapshot in BotRun when the
    # matching @cognia.contribution is invoked.
    _DEFINED_BOT_IDS.add(id)

    return Bot(
        id=id,
        name=name,
        version=version,
        executor=executor,
        triggers=[
            _validate_trigger(t, i, config_schema) for i, t in enumerate(triggers)
        ],
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
        lifecycle=lifecycle_dict,
    )


__all__ = [
    "BOT_EVENT_SOURCES",
    "BOT_EXECUTORS",
    "BOT_LIFECYCLE_HOOKS",
    "BOT_LIFECYCLE_PY_METHODS",
    "BOT_TRIGGER_KINDS",
    "Bot",
    "BotApprovalRequest",
    "BotRun",
    "BotRunParked",
    "bot_run",
    "define_bot",
    "is_bot_contribution",
]
