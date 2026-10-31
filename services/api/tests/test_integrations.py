from app.integrations import CATALOG, IntegrationSpec, IntegrationStatus as S, resolve_status
from app.integrations.base import AuthKind


def spec(**kw):
    return IntegrationSpec("x", "X", "dev", "d", AuthKind.api_key, env_vars=("X_KEY",), **kw)


def test_catalog_ids_unique_and_all_planned():
    ids = [s.id for s in CATALOG]
    assert len(ids) == len(set(ids))
    assert all(resolve_status(s, {"GITHUB_TOKEN": "x"}) is S.planned for s in CATALOG)


def test_status_ladder():
    assert resolve_status(spec(), {}) is S.planned
    assert resolve_status(spec(implemented=True), {}) is S.not_configured
    assert resolve_status(spec(implemented=True), {"X_KEY": "v"}) is S.configured_unverified
    assert resolve_status(spec(implemented=True, verifier=lambda e: True), {"X_KEY": "v"}) is S.connected


def test_failed_or_crashing_verifier_never_reports_connected():
    assert resolve_status(spec(implemented=True, verifier=lambda e: False), {"X_KEY": "v"}) is S.configured_unverified

    def boom(_):
        raise RuntimeError

    assert resolve_status(spec(implemented=True, verifier=boom), {"X_KEY": "v"}) is S.configured_unverified
