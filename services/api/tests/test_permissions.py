import pytest

from app.permissions import PermissionMode as M, Risk as R, Verdict as V, evaluate, policy_matrix


@pytest.mark.parametrize("mode,risk,verdict", [
    (M.review, R.read, V.allow), (M.review, R.write, V.deny), (M.review, R.sensitive, V.deny),
    (M.execute, R.read, V.allow), (M.execute, R.write, V.allow), (M.execute, R.sensitive, V.require_approval),
    (M.approve, R.read, V.allow), (M.approve, R.write, V.require_approval), (M.approve, R.sensitive, V.require_approval),
])
def test_policy_table(mode, risk, verdict):
    assert evaluate(mode, risk).verdict is verdict


def test_sensitive_is_never_auto_allowed():
    assert all(evaluate(m, R.sensitive).verdict is not V.allow for m in M)


def test_matrix_is_complete():
    assert len(policy_matrix()) == len(M) * len(R)
