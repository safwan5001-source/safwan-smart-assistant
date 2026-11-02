"""Endpoints reachable only through the BFF with a valid service signature (never public)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from .assistant import AssistantUnavailable, get_provider

from .config import Settings, get_settings
from .service_auth import ServiceCall, require_service_call
from .status import health_payload

router = APIRouter(prefix="/internal/v1", include_in_schema=False)


@router.get("/ping")
def ping(settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    """Proves the BFF -> API hop end to end: signature, freshness, replay protection, shared nonce store."""
    return health_payload(settings)


class InternalChatTurn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=8000)


class InternalChatRequest(BaseModel):
    messages: list[InternalChatTurn] = Field(min_length=1, max_length=40)


@router.post("/assistant/respond")
def internal_assistant_respond(
    payload: InternalChatRequest,
    settings: Settings = Depends(get_settings),
    _: ServiceCall = Depends(require_service_call),
):
    """Signed BFF-only assistant boundary. No public endpoint or key exposure."""
    if payload.messages[-1].role != "user":
        raise HTTPException(status_code=422, detail={"code": "invalid_conversation"})
    try:
        provider = get_provider(settings)
        answer = provider.respond([m.model_dump() for m in payload.messages])
    except AssistantUnavailable:
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"}) from None
    return {"provider": provider.name, "content": answer}
