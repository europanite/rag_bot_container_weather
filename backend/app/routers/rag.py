from __future__ import annotations

import logging
import os
from http import HTTPStatus
from typing import Literal

import rag_store
import requests
import weather_service
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from rag_store import RAGChunk

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rag", tags=["rag"])

# Use a module-level session so tests can monkeypatch it.
_session = requests.Session()


def _truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


# -------------------------------------------------------------------
# Request / response models
# -------------------------------------------------------------------


class IngestRequest(BaseModel):
    documents: list[str] = Field(..., description="Raw texts to ingest into the vector store.")


class IngestResponse(BaseModel):
    ingested: int


class QueryRequest(BaseModel):
    question: str = Field(..., min_length=1)

    top_k: int = Field(
        5,
        ge=1,
        le=20,
        description="Number of similar chunks to retrieve from the vector store.",
    )

    extra_context: str | None = Field(
        default=None,
        description=(
            "Optional short-lived context that should NOT be stored in RAG "
            "(e.g., live weather fetched at runtime)."
        ),
    )

    # Backward-compat aliases for older clients/scripts
    context: str | None = Field(default=None, description="Alias for extra_context")
    user_context: str | None = Field(default=None, description="Alias for extra_context")

    use_live_weather: bool = Field(
        default=False,
        description=(
            "If true and extra_context is not provided, the backend fetches the "
            "current weather for the requester and appends it as live context."
        ),
    )

    include_debug: bool = Field(
        default=False,
        description="If true, include retrieved RAG context and chunk metadata in the response.",
    )

    output_style: Literal["default", "tweet_bot"] = Field(
        default="tweet_bot",
        description="Controls output style. 'tweet_bot' produces a single friendly tweet-like post.",
    )

    max_chars: int = Field(
        default=512,
        ge=50,
        le=1024,
        description="Maximum characters for the generated post (tweet is 280).",
    )


class ChunkOut(BaseModel):
    id: str | None = None
    text: str
    distance: float | None = None
    metadata: dict = Field(default_factory=dict)


class QueryResponse(BaseModel):
    answer: str
    context: list[str] | None = None
    chunks: list[ChunkOut] | None = None


class StatusResponse(BaseModel):
    docs_dir: str
    json_files: int
    chunks_in_store: int
    files: list[str]


class ReindexResponse(BaseModel):
    documents: int
    chunks: int
    files: int


# -------------------------------------------------------------------
# Ollama chat wrapper
# -------------------------------------------------------------------


def _get_ollama_chat_model() -> str:
    return os.getenv("OLLAMA_CHAT_MODEL", "llama3.1")


def _get_ollama_base_url() -> str:
    return os.getenv("OLLAMA_BASE_URL", "http://ollama:11434").rstrip("/")

def _get_ollama_chat_timeout() -> int:
    """
    Seconds for requests timeout to Ollama /api/chat.
    """
    raw = os.getenv("OLLAMA_CHAT_TIMEOUT", "300")
    try:
        v = int(raw)
        return v if v > 0 else 300
    except Exception:
        return 300

def _call_ollama_chat(*, question: str, system_prompt: str, user_prompt: str) -> str:
    """Call Ollama's /api/chat endpoint."""
    base_url = _get_ollama_base_url()
    model = _get_ollama_chat_model()

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
    }

    try:
        timeout_s = _get_ollama_chat_timeout()
        resp = _session.post(f"{base_url}/api/chat", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        data = resp.json()

        message = data.get("message") or {}
        content = message.get("content")
        if not isinstance(content, str):
            raise RuntimeError("Ollama chat response missing 'message.content'")
    except Exception as e:
        logger.exception("Ollama chat failed: %s", e)
        raise RuntimeError(f"Ollama chat failed: {e}") from e

    return content


def _chunk_id_from_metadata(meta: dict) -> str | None:
    doc_id = meta.get("doc_id")
    idx = meta.get("chunk_index")
    if idx is None:
        idx = meta.get("index")
    if isinstance(doc_id, str) and doc_id and idx is not None:
        return f"{doc_id}:{idx}"
    return None


# -------------------------------------------------------------------
# Tweet-bot helpers (output only; no citations/sources in the text)
# -------------------------------------------------------------------


def _get_bot_name() -> str:
    return os.getenv("WEATHER_BOT_NAME", "YokoWeather")


def _get_bot_hashtags() -> str:
    # Space-separated or comma-separated accepted; we pass through to the model.
    return os.getenv("HASHTAGS", "#Yokosuka #MiuraPeninsula #Kanagawa")


def _clean_single_line(text: str) -> str:
    return " ".join(text.replace("\n", " ").replace("\r", " ").replace("\t", " ").split()).strip()


def _strip_wrapping_quotes(text: str) -> str:
    s = text.strip()
    pairs = [
        ('"', '"'),
        ("'", "'"),
        ("“", "”"),
        ("‘", "’"),
        ("`", "`"),
    ]
    for a, b in pairs:
        if s.startswith(a) and s.endswith(b) and len(s) >= 2:
            s = s[1:-1].strip()
    return s


def _enforce_max_chars(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    cut = text[: max_chars - 1]
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip() + "…"


def _build_chat_prompts(
    *,
    question: str,
    rag_context: list[str],
    live_weather: str | None,
    output_style: str,
    max_chars: int,
    place_hint: str | None,
) -> tuple[str, str]:
    if output_style != "tweet_bot":
        system = "You answer using the given context."
        ctx = "\n\n".join(rag_context + ([live_weather] if live_weather else []))
        user = (
            "Use the context below aside from general knowledge to answer the question.\n\n"
            f"Context:\n{ctx}\n\n"
            f"Question:\n{question}\n"
        )
        return system, user

    bot_name = _get_bot_name()
    hashtags = _get_bot_hashtags()
    place = place_hint or os.getenv("PLACE") or "your area"

    system = (
        f"You are {bot_name}, a friendly English local story bot for {place} (locals & tourists). "
        f"Write ONE tweet in English within {max_chars} characters. "
        "No markdown, no lists, no extra commentary, no quotes.\n"
        "Never mention sources, retrieval, RAG, or the word 'context'.\n"
        "\n"
        "TIME & GREETING (IMPORTANT):\n"
        "- Determine the local datetime from LIVE WEATHER JSON.\n"
        "- Prefer LIVE WEATHER.current.time and LIVE WEATHER.timezone. If timezone is missing, assume Asia/Tokyo (JST).\n"
        "- HOLIDAY OVERRIDE (date-based, day-limited):\n"
        "  * 12-24 => 'Merry Christmas Eve'\n"
        "  * 12-25 => 'Merry Christmas'\n"
        "  * 12-31 => \"Happy New Year's Eve\"\n"
        "  * from 01-01  to 01-04 => 'Happy New Year'\n"
        "  If today's local date matches one of these, start with that greeting and do NOT use the hour-based greetings.\n"
        "- Otherwise, start with exactly one greeting based on local hour:\n"
        "  * 05:00-10:59 => 'Good morning'\n"
        "  * 11:00-16:59 => 'Good afternoon'\n"
        "  * 17:00-21:59 => 'Good evening'\n"
        "  * 22:00-04:59 => 'Good night'\n"
        "\n"
        "STYLE:\n"
        "- Warm, upbeat, practical.\n"
        "- Use emojis.\n"
        f"- If you add hashtags, pick 1-3 from: {hashtags}.\n"
    )

    rag_lines = "\n".join(f"- {c}" for c in rag_context[:5]) if rag_context else "- (none)"
    live_block = live_weather.strip() if isinstance(live_weather, str) and live_weather.strip() else "(not available)"

    user = (
        "LIVE WEATHER:\n"
        f"{live_block}\n\n"
        "RAG CONTEXT:\n"
        f"{rag_lines}\n\n"
        "TASK:\n"
        f"{question}\n\n"
        "Remember: output ONLY the tweet text."
    )
    return system, user


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
def status() -> StatusResponse:
    docs_dir = os.getenv("RAG_DOCS_DIR") or os.getenv("DOCS_DIR", "/data/docs")
    file_paths = rag_store.list_json_files(docs_dir)
    file_names = [os.path.basename(p) for p in file_paths][:50]

    return StatusResponse(
        docs_dir=docs_dir,
        json_files=len(file_paths),
        chunks_in_store=rag_store.get_collection_count(),
        files=file_names,
    )


@router.post("/ingest", response_model=IngestResponse)
def ingest_rag(request: IngestRequest) -> IngestResponse:
    """(Optional) Ingest raw texts (kept for backwards-compat / testing).

    In production, prefer indexing from JSON files via /rag/reindex or startup auto-index.
    """
    docs = [d.strip() for d in request.documents if d and d.strip()]

    if not docs:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="No documents provided.",
        )

    successes = 0
    last_error: Exception | None = None

    for text in docs:
        try:
            rag_store.add_document(text)
            successes += 1
        except Exception as exc:
            logger.exception("Failed to ingest document", exc_info=exc)
            last_error = exc

    if successes == 0 and last_error is not None:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=f"Document ingestion failed: {last_error}",
        )

    return IngestResponse(ingested=successes)


@router.post("/reindex", response_model=ReindexResponse)
def reindex() -> ReindexResponse:
    """Clear and rebuild the vector DB from JSON files in DOCS_DIR."""
    docs_dir = os.getenv("RAG_DOCS_DIR") or os.getenv("DOCS_DIR", "/data/docs")
    enabled = _truthy(os.getenv("RAG_REINDEX_ENABLED", "true"))
    if not enabled:
        raise HTTPException(
            status_code=HTTPStatus.FORBIDDEN,
            detail="Reindex is disabled by configuration.",
        )

    try:
        stats = rag_store.rebuild_from_json_dir(docs_dir)
        return ReindexResponse(**stats)
    except Exception as exc:
        logger.exception("Reindex failed", exc_info=exc)
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=str(exc),
        ) from exc

@router.post("/query", response_model=QueryResponse)
def query_rag(payload: QueryPayload) -> QueryResponse:
    # Validate inputs
    payload.question = (payload.question or "").strip()
    if not payload.question:
        raise HTTPException(status_code=400, detail="question is required")

    if payload.top_k is None:
        payload.top_k = 6

    if payload.max_chars is None:
        payload.max_chars = 512

    # Query
    try:
        raw_k = payload.top_k * 4 if payload.output_style == "tweet_bot" else payload.top_k
        chunks = rag_store.query_similar_chunks(payload.question, top_k=raw_k)

        if payload.output_style == "tweet_bot":
            seen = set()
            diversified = []
            for c in sorted(chunks, key=lambda x: x.distance):
                meta = c.metadata if isinstance(c.metadata, dict) else {}
                key = meta.get("file") or meta.get("doc_id") or (c.text or "")[:40]
                if key in seen:
                    continue

                diversified.append(c)
                seen.add(key)
                if len(diversified) >= payload.top_k:
                    break
            chunks = diversified or chunks[: payload.top_k]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"rag query failed: {e}")

    # Build context
    context_texts = []
    for c in chunks:
        if c.text:
            context_texts.append(c.text)

    # Build prompts & call LLM
    system_prompt, user_prompt = _build_chat_prompts(
        question=payload.question,
        context_texts=context_texts,
        use_live_weather=payload.use_live_weather,
        output_style=payload.output_style,
        max_chars=payload.max_chars,
    )

    llm_text = call_llm(system_prompt=system_prompt, user_prompt=user_prompt)
    llm_text = (llm_text or "").strip()
    llm_text = _enforce_max_chars(llm_text, payload.max_chars)

    # Debug (optional)
    chosen = chunks[0] if chunks else None
    chunk_out = None
    if payload.include_debug:
        chunk_out = []
        for c in chunks[: payload.top_k]:
            md = c.metadata if isinstance(c.metadata, dict) else {}
            chunk_out.append(
                ChunkOut(
                    text=c.text,
                    distance=c.distance,
                    metadata=md,
                )
            )

    return QueryResponse(
        text=llm_text,
        chunks=chunk_out,
        chosen_chunk=(
            ChunkOut(
                text=chosen.text,
                distance=chosen.distance,
                metadata=(chosen.metadata if isinstance(chosen.metadata, dict) else {}),
            )
            if chosen
            else None
        ),
    )