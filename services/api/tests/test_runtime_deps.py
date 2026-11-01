"""Guards the Railway install contract for services/api.

Incident (2026-11-01): `safwan-api` built "successfully" on Railway but crashed with
`uvicorn: command not found`. Railpack (the Railway builder) only installs Python dependencies from a
recognised manifest: `requirements.txt`, or `pyproject.toml` PLUS a lockfile (`uv.lock`, `poetry.lock`,
`pdm.lock`). A bare `pyproject.toml` detects as Python but installs nothing, so the start command's
`uvicorn` never exists in the image. `uv.lock` is the manifest this service uses; these tests make sure it
stays present, complete and in sync with `pyproject.toml`. Refresh it with `cd services/api && uv lock`.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
# The Railway start command is `uvicorn app.main:app ...` (see docs/deploy/RAILWAY-API-PHASE2.md).
RUNTIME_REQUIRED = {"fastapi", "uvicorn", "pydantic"}


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _split(req: str) -> tuple[str, frozenset[str]]:
    m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)", req)
    assert m, f"unparseable requirement: {req!r}"
    return _norm(m.group(1)), frozenset(c.strip().replace(" ", "") for c in m.group(2).split(",") if c.strip())


def check_install_contract(pyproject: Path, lock: Path) -> list[str]:
    """Returns human-readable problems; empty means Railpack will install every runtime dependency."""
    problems: list[str] = []
    if not lock.is_file():
        return [f"{lock.name} is missing next to {pyproject.name}: Railpack installs nothing from a bare pyproject.toml, "
                "so the Railway image has no uvicorn/fastapi (run `uv lock` in services/api)."]
    project = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]
    runtime = {_split(r)[0] for r in project.get("dependencies", [])}
    missing = sorted(RUNTIME_REQUIRED - runtime)
    if missing:
        problems.append(f"runtime dependencies missing from [project].dependencies (test extras are not installed in production): {missing}")

    packages = tomllib.loads(lock.read_text(encoding="utf-8")).get("package", [])
    locked = {_norm(p["name"]) for p in packages}
    problems += [f"{n} is declared in pyproject.toml but absent from {lock.name}" for n in sorted(runtime - locked)]

    root = next((p for p in packages if _norm(p["name"]) == _norm(project["name"])), None)
    if root is None:
        problems.append(f"{lock.name} has no entry for the project itself ({project['name']}); regenerate it with `uv lock`")
        return problems
    declared: set[tuple[str, frozenset[str], str | None]] = {(*_split(r), None) for r in project.get("dependencies", [])}
    for extra, reqs in project.get("optional-dependencies", {}).items():
        declared |= {(*_split(r), extra) for r in reqs}
    in_lock: set[tuple[str, frozenset[str], str | None]] = set()
    for r in root.get("metadata", {}).get("requires-dist", []):
        marker = re.search(r"extra\s*==\s*'([^']+)'", r.get("marker", "") or "")
        in_lock.add((_norm(r["name"]), frozenset(c.strip().replace(" ", "") for c in r.get("specifier", "").split(",") if c.strip()),
                     marker.group(1) if marker else None))
    if declared != in_lock:
        problems.append(f"{lock.name} is out of date with pyproject.toml (differs: {sorted(map(str, declared ^ in_lock))}); run `uv lock`")
    return problems


def test_service_dependencies_install_on_railway():
    assert check_install_contract(API_DIR / "pyproject.toml", API_DIR / "uv.lock") == []


# --- the guard itself must catch every way the incident can recur -------------------------------------------------

PYPROJECT = """[project]
name = "demo-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.115,<1", "uvicorn>=0.30,<1", "pydantic>=2,<3"]
[project.optional-dependencies]
test = ["pytest>=8,<10"]
"""

LOCK = """version = 1
requires-python = ">=3.11"
[[package]]
name = "fastapi"
version = "0.1.0"
[[package]]
name = "uvicorn"
version = "0.1.0"
[[package]]
name = "pydantic"
version = "2.0.0"
[[package]]
name = "demo-api"
version = "0.1.0"
source = { virtual = "." }
[package.metadata]
requires-dist = [
    { name = "fastapi", specifier = ">=0.115,<1" },
    { name = "pydantic", specifier = ">=2,<3" },
    { name = "pytest", marker = "extra == 'test'", specifier = ">=8,<10" },
    { name = "uvicorn", specifier = ">=0.30,<1" },
]
"""


def _project(tmp_path: Path, pyproject: str = PYPROJECT, lock: str | None = LOCK) -> tuple[Path, Path]:
    (tmp_path / "pyproject.toml").write_text(pyproject, encoding="utf-8")
    if lock is not None:
        (tmp_path / "uv.lock").write_text(lock, encoding="utf-8")
    return tmp_path / "pyproject.toml", tmp_path / "uv.lock"


def test_guard_accepts_a_consistent_project(tmp_path):
    assert check_install_contract(*_project(tmp_path)) == []


def test_guard_fails_when_the_lockfile_is_missing(tmp_path):
    problems = check_install_contract(*_project(tmp_path, lock=None))
    assert problems and "installs nothing" in problems[0]


def test_guard_fails_when_uvicorn_is_only_a_test_extra(tmp_path):
    py = PYPROJECT.replace('"uvicorn>=0.30,<1", ', "").replace('"pytest>=8,<10"', '"pytest>=8,<10", "uvicorn>=0.30,<1"')
    assert any("uvicorn" in p for p in check_install_contract(*_project(tmp_path, py)))


def test_guard_fails_when_a_runtime_dependency_is_not_locked(tmp_path):
    lock = LOCK.replace('[[package]]\nname = "uvicorn"\nversion = "0.1.0"\n', "")
    assert any("uvicorn is declared" in p for p in check_install_contract(*_project(tmp_path, lock=lock)))


def test_guard_fails_when_the_lockfile_is_stale(tmp_path):
    py = PYPROJECT.replace('"pydantic>=2,<3"', '"pydantic>=2,<3", "psycopg[binary]>=3.2,<4"')
    assert any("out of date" in p for p in check_install_contract(*_project(tmp_path, py)))


def test_guard_fails_when_a_specifier_changes_without_relocking(tmp_path):
    py = PYPROJECT.replace("fastapi>=0.115,<1", "fastapi>=0.116,<1")
    assert any("out of date" in p for p in check_install_contract(*_project(tmp_path, py)))


@pytest.mark.parametrize("name", ["fastapi", "uvicorn", "pydantic"])
def test_real_project_declares_runtime_dependency(name):
    deps = tomllib.loads((API_DIR / "pyproject.toml").read_text(encoding="utf-8"))["project"]["dependencies"]
    assert name in {_split(d)[0] for d in deps}
