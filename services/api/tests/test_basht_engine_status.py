"""BASHT engine status (batch 3): GET /internal/v1/basht/engine-status — one fixed, validated shape; nothing unexpected passes."""
import json

import pytest

from app import basht_chat as bc
from app.audit import audit_log
from tests.test_basht_voice_status import call, client, engine, env  # noqa: F401  (shared fixtures: signed calls and the faked engine)

GOOD = {
    "ok": True, "appSession": "agent:main:app", "link": {"state": "up", "since": 1, "lastError": "ws://10.0.0.5:1234 refused", "pendingApprovals": 2},
    "features": ["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1", "history.images.v1", "media.inline.v1", "media.guard.v1",
                 "runs.runId.v1", "errorCode.rate_limited.v1", "internal.debug", "../../etc/passwd", 7],
    "wrapper": {"commit": "0123456789ab", "env": {"RAILWAY_TOKEN": "SECRET"}},
    "attachments": {"maxImages": 8, "maxImageBytes": 10485760, "maxTotalImageBytes": 19922944, "maxFileBytes": 26214400, "maxInlineBytes": 8388608, "path": "/data/x"},
    "voice": {"speak": "ready", "tts": {"voiceId": "SECRET-VOICE"}, "warnings": ["config at /data/openclaw.json"]},
    "runs": {"active": 1, "engine": 3, "cron": 0, "approvalsPending": 2, "total": 4, "complete": True},
    "signing": {"mode": "optional", "active": True, "reason": "secret at /run/x", "warnings": ["w"], "replayProtection": "memory+boot_fence", "lastRejected": {"reason": "signature"}},
    "engine": {"version": "2026.5.1", "host": "engine.internal"},
}


def get(client):
    r = call(client, "GET", "/internal/v1/basht/engine-status")
    assert r.status_code == 200
    return r.json()


def test_needs_a_signed_service_call(client, engine):
    calls, _ = engine
    assert client.get("/internal/v1/basht/engine-status").status_code == 401
    assert calls == []


def test_the_full_status_is_reduced_to_the_fixed_shape(client, engine):
    _, replies = engine
    replies["/status"] = GOOD
    j = get(client)
    assert j == {
        "ok": True, "ageMs": 0, "engine": {"version": "2026.5.1"}, "wrapper": {"commit": "0123456789ab"},
        "features": ["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1", "history.images.v1", "media.inline.v1", "media.guard.v1", "runs.runId.v1", "errorCode.rate_limited.v1"],
        "attachments": {"maxImages": 8, "maxImageBytes": 10485760, "maxTotalImageBytes": 19922944, "maxFileBytes": 26214400, "maxInlineBytes": 8388608},
        "link": {"state": "up", "pendingApprovals": 2}, "voice": {"speak": "ready"},
        "runs": {"active": 1, "total": 4, "approvalsPending": 2, "complete": True}, "signing": {"mode": "optional", "active": True},
    }
    for leak in ("SECRET", "/data", "/run/x", "10.0.0.5", "engine.internal", "agent:main", "passwd", "debug", "lastRejected", "warnings"):
        assert leak not in json.dumps(j), leak


def test_an_older_engine_without_the_new_fields_gets_only_what_it_has(client, engine):
    _, replies = engine
    replies["/status"] = {"ok": True, "link": {"state": "up"}, "voice": {"speak": "ready"}, "features": ["voice.speak.v2"]}
    assert get(client) == {"ok": True, "ageMs": 0, "wrapper": {"commit": None}, "features": ["voice.speak.v2"], "link": {"state": "up"}, "voice": {"speak": "ready"}}


@pytest.mark.parametrize("bad", [None, [], "ok", 5, {"ok": False}, {"ok": False, "error": "x"}])
def test_a_non_status_answer_is_not_ok(client, engine, bad):
    _, replies = engine
    replies["/status"] = bad
    assert get(client) == {"ok": False}


def test_an_unreachable_or_unconfigured_engine_is_ok_false_with_http_200(client, engine, monkeypatch):
    from urllib.error import URLError
    _, replies = engine
    replies["/status"] = URLError("down")
    assert get(client) == {"ok": False}
    bc.reset_limits()
    monkeypatch.delenv("BASHT_CORE_URL")
    assert get(client) == {"ok": False}


@pytest.mark.parametrize("commit", ["XYZ", "0123456789abc", "0123456", "0123456789AB", " 0123456789a", "", None, 5, ["a"], "../../..", "0123 56789ab"])
def test_commit_is_short_lowercase_hex_or_null(client, engine, commit):
    _, replies = engine
    replies["/status"] = {"ok": True, "wrapper": {"commit": commit}}
    expected = commit if commit in ("0123456",) else None
    assert get(client)["wrapper"] == {"commit": expected}


@pytest.mark.parametrize("version", ["a" * 33, "", "1.0 beta", "../x", "1.0\n2", 5, None, ["1"], "é1"])
def test_a_bad_version_is_dropped(client, engine, version):
    _, replies = engine
    replies["/status"] = {"ok": True, "engine": {"version": version}}
    assert "engine" not in get(client)


@pytest.mark.parametrize("value", [True, False, -1, 1.5, "8", None, [8], {"a": 1}, 2**40, float("1e9")])
def test_attachment_limits_must_be_bounded_non_negative_integers(client, engine, value):
    _, replies = engine
    replies["/status"] = {"ok": True, "attachments": {"maxImages": value, "maxFileBytes": value}}
    assert get(client)["attachments"] == {}


def test_attachment_limits_boundaries(client, engine):
    _, replies = engine
    replies["/status"] = {"ok": True, "attachments": {"maxImages": 1000, "maxFileBytes": 1024 ** 3, "maxImageBytes": 0, "maxInlineBytes": 1001 * 0 + 1024 ** 3 + 1}}
    assert get(client)["attachments"] == {"maxImages": 1000, "maxImageBytes": 0, "maxFileBytes": 1024 ** 3}
    replies["/status"] = {"ok": True, "attachments": {"maxImages": 1001}}
    bc.reset_limits()
    assert get(client)["attachments"] == {}


@pytest.mark.parametrize("state", ["sideways", "UP", "", None, 3, ["up"]])
def test_link_state_is_an_allowlisted_token(client, engine, state):
    _, replies = engine
    replies["/status"] = {"ok": True, "link": {"state": state, "pendingApprovals": "7"}}
    assert get(client)["link"] == {}


@pytest.mark.parametrize("state", ["off", "connecting", "up", "down"])
def test_link_states_pass(client, engine, state):
    _, replies = engine
    replies["/status"] = {"ok": True, "link": {"state": state}}
    assert get(client)["link"] == {"state": state}
    bc.reset_limits()


def test_voice_and_signing_are_allowlisted(client, engine):
    _, replies = engine
    replies["/status"] = {"ok": True, "voice": {"speak": "ready", "reason": "free text from the provider"}, "signing": {"mode": "paranoid", "active": "yes", "error": "secret_invalid"}}
    j = get(client)
    assert j["voice"] == {"speak": "ready"} and j["signing"] == {}
    bc.reset_limits()
    replies["/status"] = {"ok": True, "voice": {"speak": "mismatch", "reason": "identity_mismatch"}, "signing": {"mode": "required", "active": False}}
    j = get(client)
    assert j["voice"] == {"speak": "mismatch", "reason": "identity_mismatch"} and j["signing"] == {"mode": "required", "active": False}
    bc.reset_limits()
    replies["/status"] = {"ok": True, "voice": {"speak": "loud"}}
    assert "voice" not in get(client)


def test_runs_counts_are_bounded_and_complete_is_strictly_true(client, engine):
    _, replies = engine
    replies["/status"] = {"ok": True, "runs": {"active": "1", "total": -4, "approvalsPending": None, "complete": "true"}}
    assert get(client)["runs"] == {"active": None, "total": None, "approvalsPending": None, "complete": False}


def test_features_are_limited_to_the_known_ids_in_a_fixed_order(client, engine):
    _, replies = engine
    replies["/status"] = {"ok": True, "features": ["runs.runId.v1", "voice.speak.v2", "x" * 500, {"a": 1}, "voice.speak.v2"] + ["junk"] * 100}
    assert get(client)["features"] == ["voice.speak.v2", "runs.runId.v1"]
    bc.reset_limits()
    replies["/status"] = {"ok": True, "features": "voice.speak.v2"}
    assert "features" not in get(client)


def test_one_engine_read_per_30_seconds_is_shared_with_voice_status(client, engine):
    calls, replies = engine
    replies["/status"] = GOOD
    get(client)
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "ready"
    get(client)
    assert len(calls) == 1, "engine-status and voice-status share ONE cached engine read"


def test_a_failed_read_is_remembered_briefly_and_recovers(client, engine, monkeypatch):
    from urllib.error import URLError
    calls, replies = engine
    replies["/status"] = URLError("down")
    assert get(client) == {"ok": False}
    assert get(client) == {"ok": False} and len(calls) == 1
    now = [bc.time.monotonic() + bc.VOICE_STATUS_FAIL_TTL + 1]
    monkeypatch.setattr(bc.time, "monotonic", lambda: now[0])
    replies["/status"] = GOOD
    assert get(client)["ok"] is True and len(calls) == 2


def _audits():
    return [e for e in audit_log.recent(50) if e["event"] == "basht.voice_status"]


def test_exactly_one_audit_line_per_real_engine_read_whichever_route_triggered_it(client, engine):
    """The audit line is written where the engine is really read: engine-status first, then voice-status from the cache = ONE line (it used to be none)."""
    _, replies = engine
    replies["/status"] = GOOD
    audit_log.clear()
    get(client)
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "ready"
    get(client)
    assert len(_audits()) == 1 and _audits()[0]["status"] == GOOD["voice"]["speak"]
    audit_log.clear(); bc.reset_limits()
    call(client, "GET", "/internal/v1/basht/voice-status")  # the other order
    get(client)
    assert len(_audits()) == 1


def test_a_second_real_read_after_the_cache_expires_is_a_second_line(client, engine, monkeypatch):
    calls, replies = engine
    replies["/status"] = GOOD
    audit_log.clear()
    get(client)
    now = [bc.time.monotonic() + bc.VOICE_STATUS_TTL + 1]
    monkeypatch.setattr(bc.time, "monotonic", lambda: now[0])
    get(client)
    assert len(calls) == 2 and len(_audits()) == 2


def test_a_failed_real_read_is_audited_once_as_unavailable_and_carries_no_engine_text(client, engine):
    from urllib.error import URLError
    _, replies = engine
    replies["/status"] = URLError("engine.internal refused")
    audit_log.clear()
    get(client); get(client); call(client, "GET", "/internal/v1/basht/voice-status")
    assert len(_audits()) == 1 and _audits()[0]["status"] == "unavailable"
    assert "engine.internal" not in json.dumps(_audits()[0])


def test_a_cache_hit_reports_how_old_the_engine_answer_really_is(client, engine, monkeypatch):
    """The observation time travels with the answer (as an age, so no two clocks must agree): a re-fetch inside the 30 s cache is NOT newer evidence."""
    _, replies = engine
    replies["/status"] = GOOD
    t = [1000.0]
    monkeypatch.setattr(bc.time, "monotonic", lambda: t[0])
    assert get(client)["ageMs"] == 0
    t[0] = 1000.0 + 21.5
    j = get(client)
    assert j["ageMs"] == 21_500, "served from the cache: the age of the cached read"
    assert j["link"] == {"state": "up", "pendingApprovals": 2}


def test_the_age_is_capped_and_absent_when_the_read_failed(client, engine, monkeypatch):
    from urllib.error import URLError
    _, replies = engine
    replies["/status"] = GOOD
    t = [1000.0]
    monkeypatch.setattr(bc.time, "monotonic", lambda: t[0])
    monkeypatch.setattr(bc, "VOICE_STATUS_TTL", 10_000.0)
    get(client)
    t[0] = 1000.0 + 5000.0
    assert get(client)["ageMs"] == bc.MAX_AGE_MS
    bc.reset_limits(); replies["/status"] = URLError("down")
    assert get(client) == {"ok": False}


def test_concurrent_cache_misses_share_ONE_engine_read_and_write_ONE_audit_line(monkeypatch):
    """Single-flight: eight requests arriving together on an empty cache perform one read, share its answer, and audit once."""
    import threading
    bc.reset_limits(); audit_log.clear()
    started, release, calls = threading.Event(), threading.Event(), []

    def slow(method, path, body=None, env=None, timeout=0):
        calls.append(path); started.set(); assert release.wait(5); return dict(GOOD)

    monkeypatch.setattr(bc, "_call", slow)
    monkeypatch.setattr(bc, "_config", lambda env=None: ("https://engine.example", "t"))
    out: list = []
    ts = [threading.Thread(target=lambda: out.append(bc._engine_status_raw())) for _ in range(8)]
    ts[0].start(); assert started.wait(5)
    for t in ts[1:]:
        t.start()
    release.set()
    for t in ts:
        t.join(10)
    assert len(calls) == 1, "one real engine read"
    assert len(out) == 8 and all(o[0]["ok"] is True and o[1] is False for o in out)
    assert sum(1 for o in out if o[2]) == 1, "exactly one caller performed (and audited) the read"
    assert len([e for e in audit_log.recent(50) if e["event"] == "basht.voice_status"]) == 1


def test_a_follower_never_waits_forever_and_the_lock_is_not_held_across_the_read(monkeypatch):
    import threading
    bc.reset_limits()
    started, release = threading.Event(), threading.Event()

    def slow(method, path, body=None, env=None, timeout=0):
        started.set(); release.wait(5); return dict(GOOD)

    monkeypatch.setattr(bc, "_call", slow)
    monkeypatch.setattr(bc, "_config", lambda env=None: ("https://engine.example", "t"))
    monkeypatch.setattr(bc, "FLIGHT_WAIT", 0.2)
    leader = threading.Thread(target=bc._engine_status_raw); leader.start(); assert started.wait(5)
    assert bc._lock.acquire(timeout=1), "the module lock is free while the engine read is in progress"
    bc._lock.release()
    raw, failed, fresh, _ = bc._engine_status_raw()  # a follower that gives up after FLIGHT_WAIT
    assert raw is None and failed is True and fresh is False
    release.set(); leader.join(10)


def test_a_failed_leader_read_is_shared_with_followers_as_a_failure(monkeypatch):
    import threading
    from urllib.error import URLError
    bc.reset_limits(); audit_log.clear()
    started, release = threading.Event(), threading.Event()

    def boom(method, path, body=None, env=None, timeout=0):
        started.set(); release.wait(5); raise URLError("down")

    monkeypatch.setattr(bc, "_call", boom)
    monkeypatch.setattr(bc, "_config", lambda env=None: ("https://engine.example", "t"))
    out: list = []
    ts = [threading.Thread(target=lambda: out.append(bc._engine_status_raw())) for _ in range(4)]
    ts[0].start(); assert started.wait(5)
    for t in ts[1:]:
        t.start()
    release.set()
    for t in ts:
        t.join(10)
    assert all(o[1] is True for o in out)
    assert len([e for e in audit_log.recent(50) if e["event"] == "basht.voice_status"]) == 1
