"""Preview network throttle identity, bound to the actual ASGI peer.

Never accept an untrusted X-Forwarded-For or X-Real-IP value as identity.
Behind a reverse proxy, the peer is the proxy until trusted-forwarding
configuration is separately reviewed. This is a defense-in-depth primitive,
not a complete public IP rate limiter.
"""
import ipaddress
from .login_throttle import subject_digest

def network_subject(peer_host: str | None, server_key: bytes) -> bytes:
    if not peer_host:
        raise ValueError("Missing verified network peer")
    address = ipaddress.ip_address(peer_host)
    # Group IPv6 clients by /64 to avoid bypass with rotating interface IDs.
    if address.version == 6:
        address = ipaddress.ip_network(f"{address}/64", strict=False).network_address
    return subject_digest(f"network:{address.compressed}", server_key)
