"""Endpoints reachable only through the BFF with a valid service signature (never public)."""
from fastapi import APIRouter, Depends

from .config import Settings, get_settings
from .service_auth import ServiceCall, require_service_call
from .status import health_payload

router = APIRouter(prefix="/internal/v1", include_in_schema=False)


@router.get("/ping")
def ping(settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    """Proves the BFF -> API hop end to end: signature, freshness, replay protection, shared nonce store."""
    return health_payload(settings)
