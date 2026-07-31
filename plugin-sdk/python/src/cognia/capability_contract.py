"""Capability-contract helpers (Python mirror of ``plugin-capabilities.ts``).

Plugin authors declare a ``capabilities`` array in their manifest; each
capability is governed by a host contract describing its support level and
proof surfaces. ``CapabilityContract`` mirrors the TypeScript
``PluginCapabilityContract`` shape, and ``validate_capabilities`` re-implements
``validatePluginCapabilities`` so a Python plugin can self-check its declared
capabilities against a contract table before shipping.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from ._generated_contract import (
    CAPABILITY_FIELDS,
    CAPABILITY_INTRODUCED_VERSIONS,
    CAPABILITY_MINIMUM_HOST_VERSIONS,
    CAPABILITY_SUPPORT,
    CATALOG_SCHEMA_VERSION,
    MANIFEST_CONTRIBUTIONS,
    MINIMUM_HOST_VERSION,
    PLUGIN_PATH_FIELD_CONTRACTS,
    RUNTIME_ENTRY_CONTRACTS,
    VALID_CAPABILITIES,
    VALID_PERMISSIONS,
    VALID_PLUGIN_TYPES,
)

# Support levels, identical to the TypeScript `PluginCapabilitySupport` union.
SUPPORTED = "supported"
PARTIAL = "partial"
EXPERIMENTAL = "experimental"
BLOCKED = "blocked"

_SUPPORT_LEVELS = frozenset({SUPPORTED, PARTIAL, EXPERIMENTAL, BLOCKED})


@dataclass(frozen=True)
class CapabilityContract:
    """A host capability contract (mirrors ``PluginCapabilityContract``)."""

    id: str
    support: str
    manifest_fields: Sequence[str] = field(default_factory=tuple)
    introduced_in: str = ""
    minimum_host_version: str = ""
    runtime_binding: str = ""
    host_bindings: Sequence[str] = field(default_factory=tuple)
    typescript_sdk: Sequence[str] = field(default_factory=tuple)
    python_sdk: Sequence[str] = field(default_factory=tuple)
    builtin_contribution_paths: Sequence[str] = field(default_factory=tuple)
    docs: str = ""
    required_tests: Sequence[str] = field(default_factory=tuple)

    def to_dict(self) -> Dict[str, Any]:
        """Emit the camelCase shape the TypeScript contract table uses."""
        return {
            "id": self.id,
            "support": self.support,
            "manifestFields": list(self.manifest_fields),
            "introducedIn": self.introduced_in,
            "minimumHostVersion": self.minimum_host_version,
            "runtimeBinding": self.runtime_binding,
            "hostBindings": list(self.host_bindings),
            "typescriptSdk": list(self.typescript_sdk),
            "pythonSdk": list(self.python_sdk),
            "builtinContributionPaths": list(self.builtin_contribution_paths),
            "docs": self.docs,
            "requiredTests": list(self.required_tests),
        }


def define_capability_contract(
    id: str,
    support: str,
    *,
    manifest_fields: Optional[Sequence[str]] = None,
    introduced_in: str = "",
    minimum_host_version: str = "",
    runtime_binding: str = "",
    host_bindings: Optional[Sequence[str]] = None,
    typescript_sdk: Optional[Sequence[str]] = None,
    python_sdk: Optional[Sequence[str]] = None,
    builtin_contribution_paths: Optional[Sequence[str]] = None,
    docs: str = "",
    required_tests: Optional[Sequence[str]] = None,
) -> CapabilityContract:
    """Construct a validated `CapabilityContract`."""
    if not id or not id.strip():
        raise ValueError("capability contract id must be a non-empty string")
    if support not in _SUPPORT_LEVELS:
        raise ValueError(
            f"unknown support level {support!r}; expected one of "
            f"{sorted(_SUPPORT_LEVELS)}"
        )
    return CapabilityContract(
        id=id,
        support=support,
        manifest_fields=tuple(manifest_fields or ()),
        introduced_in=introduced_in,
        minimum_host_version=minimum_host_version,
        runtime_binding=runtime_binding,
        host_bindings=tuple(host_bindings or ()),
        typescript_sdk=tuple(typescript_sdk or ()),
        python_sdk=tuple(python_sdk or ()),
        builtin_contribution_paths=tuple(builtin_contribution_paths or ()),
        docs=docs,
        required_tests=tuple(required_tests or ()),
    )


@dataclass(frozen=True)
class CapabilityDiagnostic:
    """One validation diagnostic (mirrors ``PluginCapabilityDiagnostic``)."""

    code: str
    severity: str  # "warning" | "error"
    capability: str
    message: str
    hint: Optional[str] = None


@dataclass(frozen=True)
class CapabilityValidationOutcome:
    """Result of validating a capability list."""

    allowed: bool
    diagnostics: List[CapabilityDiagnostic]


def _contract_index(
    contracts: Iterable[CapabilityContract],
) -> Dict[str, CapabilityContract]:
    return {contract.id: contract for contract in contracts}


def validate_capabilities(
    capabilities: Sequence[str],
    contracts: Optional[Iterable[CapabilityContract]] = None,
    *,
    governance_mode: str = "warn",
) -> CapabilityValidationOutcome:
    """Validate declared capabilities against a contract table.

    Mirrors ``validatePluginCapabilities``: an unknown capability is an error;
    a blocked one is an error under ``governance_mode="block"`` (else a
    warning); ``partial`` / ``experimental`` are warnings; ``supported`` passes
    cleanly. ``allowed`` is true when no diagnostic has ``severity == "error"``.
    """
    index = _contract_index(
        CANONICAL_CAPABILITY_CONTRACTS if contracts is None else contracts
    )
    diagnostics: List[CapabilityDiagnostic] = []

    for capability in capabilities:
        contract = index.get(capability)
        if contract is None:
            diagnostics.append(
                CapabilityDiagnostic(
                    code="plugin.capability.unknown",
                    severity="error",
                    capability=capability,
                    message=f'Unknown capability "{capability}".',
                )
            )
            continue
        if contract.support == SUPPORTED:
            continue
        if contract.support == BLOCKED:
            diagnostics.append(
                CapabilityDiagnostic(
                    code="plugin.capability.blocked",
                    severity="error" if governance_mode == "block" else "warning",
                    capability=capability,
                    message=(
                        f'Capability "{capability}" is blocked by the current '
                        "host contract."
                    ),
                    hint=(
                        f'Remove "{capability}" from the manifest or wait until '
                        "the host exposes a supported runtime binding."
                    ),
                )
            )
            continue
        diagnostics.append(
            CapabilityDiagnostic(
                code=(
                    "plugin.capability.partial"
                    if contract.support == PARTIAL
                    else "plugin.capability.experimental"
                ),
                severity="warning",
                capability=capability,
                message=(
                    f'Capability "{capability}" is only {contract.support}ly '
                    "supported by the current host contract."
                ),
                hint=(
                    f'Use "{capability}" with caution until host/runtime parity '
                    "is completed."
                ),
            )
        )

    allowed = all(d.severity != "error" for d in diagnostics)
    return CapabilityValidationOutcome(allowed=allowed, diagnostics=diagnostics)


def capability_contract_from_dict(raw: Mapping[str, Any]) -> CapabilityContract:
    """Build a `CapabilityContract` from a camelCase dict (e.g. parsed JSON)."""
    return CapabilityContract(
        id=str(raw["id"]),
        support=str(raw["support"]),
        manifest_fields=tuple(raw.get("manifestFields", ())),
        introduced_in=str(raw.get("introducedIn", "")),
        minimum_host_version=str(raw.get("minimumHostVersion", "")),
        runtime_binding=str(raw.get("runtimeBinding", "")),
        host_bindings=tuple(raw.get("hostBindings", ())),
        typescript_sdk=tuple(raw.get("typescriptSdk", ())),
        python_sdk=tuple(raw.get("pythonSdk", ())),
        builtin_contribution_paths=tuple(raw.get("builtinContributionPaths", ())),
        docs=str(raw.get("docs", "")),
        required_tests=tuple(raw.get("requiredTests", ())),
    )


CANONICAL_CAPABILITY_CONTRACTS = tuple(
    define_capability_contract(
        capability_id,
        CAPABILITY_SUPPORT[capability_id],
        manifest_fields=CAPABILITY_FIELDS[capability_id],
        introduced_in=CAPABILITY_INTRODUCED_VERSIONS[capability_id],
        minimum_host_version=CAPABILITY_MINIMUM_HOST_VERSIONS[capability_id],
    )
    for capability_id in CAPABILITY_SUPPORT
)
