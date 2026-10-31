import pytest
from app.network_throttle import network_subject

KEY=b"ci-network-test-key-32-bytes-000000"

def test_ipv4_peers_get_distinct_keyed_buckets():
    a=network_subject("192.0.2.1",KEY)
    assert len(a)==32
    assert a!=network_subject("192.0.2.2",KEY)
    assert b"192.0.2.1" not in a

def test_ipv6_uses_common_64_prefix():
    assert network_subject("2001:db8:abcd:12::1",KEY)==network_subject("2001:db8:abcd:12::ffff",KEY)
    assert network_subject("2001:db8:abcd:12::1",KEY)!=network_subject("2001:db8:abcd:13::1",KEY)

def test_untrusted_proxy_headers_are_not_network_identity():
    for value in (None,"","not-an-ip","192.0.2.1, 198.51.100.2"):
        with pytest.raises(ValueError):
            network_subject(value,KEY)
