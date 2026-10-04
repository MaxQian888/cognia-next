"""Typed manifest mirror for the ``pi-package`` capability (ADR-0210).

Python author-facing helper mirroring the TypeScript ``definePiPackage``:

* ``pi-package`` → ``PluginPiPackageDef`` (manifest ``piPackages``)

A plugin ships a Pi coding-agent package inside its own directory. The host
installs it into the user's Pi (``pi install <abs path>``) and, when
``hosted_session`` is set, loads its extensions into Cognia-hosted Pi sessions
of agents that opt in. ``define_pi_package`` validates with the same rules as
the host manifest validator; ``to_dict()`` emits the camelCase manifest shape.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ENV_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_ABSOLUTE_OR_SCHEME = re.compile(r"^(?:/|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:)")
_PREPARE_PROGRAMS = frozenset({"npm", "pnpm"})
_EXTENSION_SUFFIXES = (".ts", ".js", ".mjs")
_PI_BUILTIN_TOOLS = frozenset({"read", "grep", "find", "ls", "edit", "write", "bash"})

#: Session env prefix the external-agent policy admits for plugin Pi packages.
PI_PACKAGE_ENV_PREFIX = "COGNIA_PIPKG_"


def _require_relative(path: str, label: str) -> None:
    if not isinstance(path, str) or not path:
        raise ValueError(f"{label} must be a non-empty plugin-relative path")
    if "\\" in path:
        raise ValueError(f"{label} must use forward slashes")
    if _ABSOLUTE_OR_SCHEME.match(path):
        raise ValueError(f"{label} must be relative to the plugin directory")
    if ".." in path.split("/"):
        raise ValueError(f"{label} must not leave the plugin directory")


@dataclass(frozen=True)
class PiPackagePrepare:
    """Dependency step run in the package directory (mirrors ``PluginPiPackagePrepare``)."""

    program: str
    args: List[str]
    marker: Optional[str] = None
    timeout_ms: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"program": self.program, "args": list(self.args)}
        if self.marker is not None:
            out["marker"] = self.marker
        if self.timeout_ms is not None:
            out["timeoutMs"] = self.timeout_ms
        return out


@dataclass(frozen=True)
class PiPackageEnvBinding:
    """One ``COGNIA_PIPKG_<name>`` value. ``source`` is ``{"config": key}``,
    ``{"value": literal}`` or ``{"workspace": True}``."""

    name: str
    source: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "from": dict(self.source)}


@dataclass(frozen=True)
class PiPackageHostedSession:
    """How the package loads into hosted sessions (mirrors ``PluginPiPackageHostedSession``)."""

    extensions: List[str]
    env: Optional[List[PiPackageEnvBinding]] = None
    tools: Optional[List[str]] = None
    controls_session: Optional[bool] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"extensions": list(self.extensions)}
        if self.env is not None:
            out["env"] = [binding.to_dict() for binding in self.env]
        if self.tools is not None:
            out["tools"] = list(self.tools)
        if self.controls_session is not None:
            out["controlsSession"] = self.controls_session
        return out


@dataclass(frozen=True)
class PiPackage:
    """A plugin-shipped Pi package (mirrors ``PluginPiPackageDef``)."""

    id: str
    name: str
    path: str
    description: Optional[str] = None
    min_pi_version: Optional[str] = None
    prepare: Optional[PiPackagePrepare] = None
    hosted_session: Optional[PiPackageHostedSession] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "name": self.name, "path": self.path}
        if self.description is not None:
            out["description"] = self.description
        if self.min_pi_version is not None:
            out["minPiVersion"] = self.min_pi_version
        if self.prepare is not None:
            out["prepare"] = self.prepare.to_dict()
        if self.hosted_session is not None:
            out["hostedSession"] = self.hosted_session.to_dict()
        return out


def _validate_source(source: Mapping[str, Any], label: str) -> Dict[str, Any]:
    if not isinstance(source, Mapping) or len(source) != 1:
        raise ValueError(f"{label} must be exactly one of config / value / workspace")
    (key, value), = source.items()
    if key == "config" and isinstance(value, str) and value:
        return {"config": value}
    if key == "value" and isinstance(value, str):
        return {"value": value}
    if key == "workspace" and value is True:
        return {"workspace": True}
    raise ValueError(f"{label} must be exactly one of config / value / workspace")


def define_pi_package(
    id: str,
    name: str,
    path: str,
    *,
    description: Optional[str] = None,
    min_pi_version: Optional[str] = None,
    prepare_program: Optional[str] = None,
    prepare_args: Optional[Sequence[str]] = None,
    prepare_marker: Optional[str] = None,
    prepare_timeout_ms: Optional[int] = None,
    extensions: Optional[Sequence[str]] = None,
    env: Optional[Mapping[str, Mapping[str, Any]]] = None,
    tools: Optional[Sequence[str]] = None,
    controls_session: Optional[bool] = None,
) -> PiPackage:
    """Construct a validated ``PiPackage``.

    ``prepare_program`` (``npm`` / ``pnpm``) enables the dependency step;
    ``extensions`` enables hosted sessions. ``env`` maps a ``COGNIA_PIPKG_``
    suffix to its source, e.g. ``{"TEX_ENGINE": {"config": "engine"}}``.
    """
    if not _ID_PATTERN.match(id or ""):
        raise ValueError(f"pi package id {id!r} must be lowercase kebab-case")
    if not name or not name.strip():
        raise ValueError("pi package name must be a non-empty string")
    _require_relative(path, "pi package path")

    prepare: Optional[PiPackagePrepare] = None
    if prepare_program is not None:
        if prepare_program not in _PREPARE_PROGRAMS:
            raise ValueError(
                f"prepare_program {prepare_program!r} must be one of {sorted(_PREPARE_PROGRAMS)}"
            )
        args = list(prepare_args or [])
        if any(not isinstance(arg, str) for arg in args):
            raise ValueError("prepare_args must be static strings")
        if prepare_marker is not None:
            _require_relative(prepare_marker, "prepare_marker")
        if prepare_timeout_ms is not None and prepare_timeout_ms <= 0:
            raise ValueError("prepare_timeout_ms must be positive")
        prepare = PiPackagePrepare(
            program=prepare_program,
            args=args,
            marker=prepare_marker,
            timeout_ms=prepare_timeout_ms,
        )

    hosted: Optional[PiPackageHostedSession] = None
    if extensions is not None:
        entries = list(extensions)
        if not entries:
            raise ValueError("extensions must list at least one entry file")
        for entry in entries:
            _require_relative(entry, f"extension {entry!r}")
            if not entry.endswith(_EXTENSION_SUFFIXES):
                raise ValueError(f"extension {entry!r} must end in .ts, .js or .mjs")
        bindings: Optional[List[PiPackageEnvBinding]] = None
        if env is not None:
            bindings = []
            for env_name, source in env.items():
                if not _ENV_NAME_PATTERN.match(env_name):
                    raise ValueError(f"env name {env_name!r} must be upper-case letters, digits and _")
                bindings.append(
                    PiPackageEnvBinding(env_name, _validate_source(source, f"env {env_name}"))
                )
        tool_list: Optional[List[str]] = None
        if tools is not None:
            tool_list = list(tools)
            for tool in tool_list:
                if not _TOOL_NAME_PATTERN.match(tool) or tool in _PI_BUILTIN_TOOLS:
                    raise ValueError(f"tool {tool!r} is not a valid, non-built-in tool name")
        hosted = PiPackageHostedSession(
            extensions=entries,
            env=bindings,
            tools=tool_list,
            controls_session=controls_session,
        )
    elif env is not None or tools is not None or controls_session is not None:
        raise ValueError("env / tools / controls_session require extensions (hosted sessions)")

    return PiPackage(
        id=id,
        name=name,
        path=path,
        description=description,
        min_pi_version=min_pi_version,
        prepare=prepare,
        hosted_session=hosted,
    )
