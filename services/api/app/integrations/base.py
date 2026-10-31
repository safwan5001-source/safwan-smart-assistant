"""Integration descriptors and honest status resolution.

Status ladder (a connector can never skip a rung):
  planned               - no connector code exists yet
  not_configured        - connector exists, server-side credentials missing
  configured_unverified - credentials present, not yet proven to work
  connected             - a live verification call succeeded
Credentials are read from server environment variables only; values never leave this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Mapping

from ..permissions import Risk


class IntegrationStatus(str, Enum):
    planned = "planned"
    not_configured = "not_configured"
    configured_unverified = "configured_unverified"
    connected = "connected"


class AuthKind(str, Enum):
    oauth2 = "oauth2"
    api_key = "api_key"
    session = "session"


@dataclass(frozen=True)
class ScopeSpec:
    id: str
    title: str
    risk: Risk


@dataclass(frozen=True)
class IntegrationSpec:
    id: str
    name: str
    category: str
    description: str
    auth: AuthKind
    scopes: tuple[ScopeSpec, ...] = ()
    env_vars: tuple[str, ...] = ()
    implemented: bool = False
    verifier: Callable[[Mapping[str, str]], bool] | None = field(default=None, compare=False)

    def public(self, environ: Mapping[str, str]) -> dict[str, object]:
        return {
            "id": self.id, "name": self.name, "category": self.category, "description": self.description,
            "auth": self.auth.value, "status": resolve_status(self, environ).value,
            "scopes": [{"id": s.id, "title": s.title, "risk": s.risk.value} for s in self.scopes],
        }


def resolve_status(spec: IntegrationSpec, environ: Mapping[str, str]) -> IntegrationStatus:
    if not spec.implemented:
        return IntegrationStatus.planned
    if not spec.env_vars or not all(environ.get(v) for v in spec.env_vars):
        return IntegrationStatus.not_configured
    if spec.verifier is not None:
        try:
            if spec.verifier(environ):
                return IntegrationStatus.connected
        except Exception:  # noqa: BLE001 - a failing probe means "not proven"
            pass
    return IntegrationStatus.configured_unverified
