"""YouTube OAuth and completed-render upload endpoints."""

import os
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from backend.config import EXPORTS_DIR, ROOT_DIR, logger

router = APIRouter(tags=["YouTube Upload"])

YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024
TOKEN_PATH = Path(
    os.environ.get(
        "YOUTUBE_TOKEN_PATH",
        str(ROOT_DIR / "backend" / "youtube_auth" / "token.json"),
    )
)

# OAuth states are short-lived and kept in memory; refresh tokens are persisted on disk.
_OAUTH_FLOWS: dict[str, tuple[object, float]] = {}
_UPLOAD_JOBS: dict[str, dict] = {}
_JOB_LOCK = threading.Lock()


class YouTubeUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=5000)
    tags: list[str] = Field(default_factory=list)
    privacy_status: Literal["private", "unlisted", "public"] = "private"


def _youtube_settings() -> dict[str, str]:
    """Read OAuth settings from the process environment, with local .env fallback.

    The backend normally loads backend/.env in backend.config. Reading the file
    here as a fallback also covers launcher/reloader processes that inherit empty
    environment variables, without logging or exposing the secret values.
    """
    settings = {
        "YOUTUBE_CLIENT_ID": os.environ.get("YOUTUBE_CLIENT_ID", "").strip(),
        "YOUTUBE_CLIENT_SECRET": os.environ.get("YOUTUBE_CLIENT_SECRET", "").strip(),
        "YOUTUBE_REDIRECT_URI": os.environ.get("YOUTUBE_REDIRECT_URI", "").strip(),
    }

    try:
        from dotenv import dotenv_values

        for env_path in (ROOT_DIR / "backend" / ".env", ROOT_DIR / ".env"):
            if settings["YOUTUBE_CLIENT_ID"] and settings["YOUTUBE_CLIENT_SECRET"] and settings["YOUTUBE_REDIRECT_URI"]:
                break
            file_values = dotenv_values(env_path)
            for key in settings:
                if not settings[key]:
                    settings[key] = str(file_values.get(key) or "").strip()
    except Exception as exc:
        logger.warning("Could not read local YouTube OAuth environment files: %s", exc)

    if not settings["YOUTUBE_REDIRECT_URI"]:
        settings["YOUTUBE_REDIRECT_URI"] = "http://localhost:8000/api/youtube/callback"

    return settings


def _oauth_configured() -> bool:
    settings = _youtube_settings()
    return bool(settings["YOUTUBE_CLIENT_ID"] and settings["YOUTUBE_CLIENT_SECRET"])


def _redirect_uri() -> str:
    return _youtube_settings()["YOUTUBE_REDIRECT_URI"]


def _client_config() -> dict:
    settings = _youtube_settings()
    client_id = settings["YOUTUBE_CLIENT_ID"]
    client_secret = settings["YOUTUBE_CLIENT_SECRET"]
    if not client_id or not client_secret:
        raise RuntimeError("YouTube OAuth client credentials are missing.")
    return {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [_redirect_uri()],
        }
    }


def _save_credentials(credentials) -> None:
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = TOKEN_PATH.with_suffix(".tmp")
    temp_path.write_text(credentials.to_json(), encoding="utf-8")
    os.replace(temp_path, TOKEN_PATH)
    try:
        os.chmod(TOKEN_PATH, 0o600)
    except OSError:
        # Windows does not support POSIX permission modes.
        pass


def _load_credentials():
    if not TOKEN_PATH.is_file():
        return None

    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        credentials = Credentials.from_authorized_user_file(
            str(TOKEN_PATH), YOUTUBE_SCOPES
        )
        if credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
            _save_credentials(credentials)

        return credentials if credentials.valid else None
    except Exception as exc:
        logger.warning("Unable to load YouTube OAuth credentials: %s", exc)
        return None


@router.get("/api/youtube/status")
def youtube_connection_status():
    """Returns configuration and connection state without exposing credentials."""
    return {
        "configured": _oauth_configured(),
        "connected": _load_credentials() is not None,
        "redirect_uri": _redirect_uri(),
    }


@router.get("/api/youtube/auth-url")
def youtube_auth_url():
    """Creates a short-lived OAuth authorization URL for the popup window."""
    if not _oauth_configured():
        raise HTTPException(
            status_code=503,
            detail="YouTube OAuth is not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to the backend environment.",
        )

    try:
        from google_auth_oauthlib.flow import Flow

        flow = Flow.from_client_config(
            _client_config(),
            scopes=YOUTUBE_SCOPES,
        )
        flow.redirect_uri = _redirect_uri()
        authorization_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="consent",
        )

        now = time.time()
        for old_state, (_, created_at) in list(_OAUTH_FLOWS.items()):
            if now - created_at > 600:
                _OAUTH_FLOWS.pop(old_state, None)
        _OAUTH_FLOWS[state] = (flow, now)

        return {
            "authorization_url": authorization_url,
            "redirect_uri": _redirect_uri(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to create YouTube OAuth authorization URL")
        raise HTTPException(
            status_code=500,
            detail=f"Could not start YouTube authorization: {exc}",
        )


@router.get("/api/youtube/callback", response_class=HTMLResponse)
def youtube_oauth_callback(
    state: Optional[str] = None,
    code: Optional[str] = None,
    error: Optional[str] = None,
):
    """Completes the Google OAuth flow and stores the refresh token."""
    flow_entry = _OAUTH_FLOWS.pop(state or "", None)
    if not flow_entry:
        return HTMLResponse(
            "<h2>Authorization expired</h2><p>Return to Cheat Clip Pro and connect YouTube again.</p>",
            status_code=400,
        )

    if error:
        return HTMLResponse(
            "<h2>YouTube connection was not completed</h2><p>You can close this window and try again.</p>",
            status_code=400,
        )

    if not code:
        return HTMLResponse(
            "<h2>Missing authorization code</h2><p>Return to Cheat Clip Pro and try again.</p>",
            status_code=400,
        )

    flow, created_at = flow_entry
    if time.time() - created_at > 600:
        return HTMLResponse(
            "<h2>Authorization expired</h2><p>Return to Cheat Clip Pro and connect YouTube again.</p>",
            status_code=400,
        )

    try:
        flow.fetch_token(code=code)
        _save_credentials(flow.credentials)
        return HTMLResponse(
            """
            <!doctype html>
            <html lang="en">
              <head><meta charset="utf-8"><title>YouTube connected</title></head>
              <body style="font-family:system-ui;background:#10131d;color:#f8fafc;display:grid;place-items:center;min-height:90vh;text-align:center">
                <main>
                  <h2 style="color:#34d399">YouTube connected successfully</h2>
                  <p>You can close this window and return to Cheat Clip Pro.</p>
                  <button onclick="window.close()" style="padding:10px 16px;border:0;border-radius:8px;cursor:pointer">Close window</button>
                </main>
                <script>setTimeout(() => window.close(), 1200);</script>
              </body>
            </html>
            """
        )
    except Exception:
        logger.exception("YouTube OAuth callback failed")
        return HTMLResponse(
            "<h2>Could not connect YouTube</h2><p>Check the OAuth redirect URI and try again.</p>",
            status_code=400,
        )


@router.post("/api/youtube/disconnect")
def youtube_disconnect():
    """Removes the locally stored Google refresh token."""
    try:
        if TOKEN_PATH.exists():
            TOKEN_PATH.unlink()
        return {"success": True, "connected": False}
    except OSError as exc:
        logger.error("Could not remove YouTube OAuth token: %s", exc)
        raise HTTPException(status_code=500, detail="Could not disconnect the YouTube account.")


def _set_job(upload_id: str, **updates) -> None:
    with _JOB_LOCK:
        job = _UPLOAD_JOBS.get(upload_id)
        if job:
            job.update(updates)


def _run_youtube_upload(upload_id: str, file_path: Path, payload: dict) -> None:
    """Uploads one completed MP4 using YouTube's resumable upload API."""
    _set_job(upload_id, status="uploading", progress_percent=0, message="Preparing upload")

    try:
        credentials = _load_credentials()
        if credentials is None:
            raise RuntimeError("YouTube is no longer connected. Reconnect your account and try again.")

        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload

        youtube = build("youtube", "v3", credentials=credentials, cache_discovery=False)
        tags = []
        tag_characters = 0
        for raw_tag in payload.get("tags", []):
            if not isinstance(raw_tag, str):
                continue
            tag = raw_tag.strip()[:100]
            if not tag:
                continue
            separator_length = 1 if tags else 0
            if tag_characters + separator_length + len(tag) > 500:
                break
            tags.append(tag)
            tag_characters += separator_length + len(tag)

        body = {
            "snippet": {
                "title": payload["title"].strip(),
                "description": payload.get("description", "").strip(),
                "categoryId": "22",
            },
            "status": {
                "privacyStatus": payload.get("privacy_status", "private"),
            },
        }
        if tags:
            body["snippet"]["tags"] = tags

        media = MediaFileUpload(
            str(file_path),
            mimetype="video/mp4",
            chunksize=8 * 1024 * 1024,
            resumable=True,
        )
        insert_request = youtube.videos().insert(
            part="snippet,status",
            body=body,
            media_body=media,
        )

        response = None
        while response is None:
            upload_status, response = insert_request.next_chunk(num_retries=5)
            if upload_status:
                percent = max(0, min(100, int(upload_status.progress() * 100)))
                _set_job(
                    upload_id,
                    status="uploading",
                    progress_percent=percent,
                    message=f"Uploading video: {percent}%",
                )

        video_id = response.get("id")
        if not video_id:
            raise RuntimeError("YouTube did not return a video ID.")

        _set_job(
            upload_id,
            status="completed",
            progress_percent=100,
            message="Upload complete",
            video_id=video_id,
            watch_url=f"https://www.youtube.com/watch?v={video_id}",
        )
        logger.info("YouTube upload completed: %s", video_id)
    except Exception as exc:
        logger.exception("YouTube upload failed for job %s", upload_id)
        _set_job(
            upload_id,
            status="failed",
            progress_percent=0,
            message="Upload failed",
            error=str(exc)[:500],
        )


@router.post("/api/youtube/prepare")
async def prepare_youtube_upload(file: UploadFile = File(...)):
    """Stores a browser-rendered MP4 in the export directory for the uploader."""
    if not _oauth_configured() or _load_credentials() is None:
        raise HTTPException(
            status_code=401,
            detail="Connect your YouTube account before preparing a video.",
        )

    original_name = Path(file.filename or "clip.mp4").name
    if Path(original_name).suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="Only MP4 videos can be uploaded.")

    filename = f"youtube_{uuid.uuid4().hex[:12]}.mp4"
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    file_path = (EXPORTS_DIR / filename).resolve()

    try:
        file_path.relative_to(EXPORTS_DIR.resolve())
        size = 0
        with file_path.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_VIDEO_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="The video exceeds YouTube's 256 GB upload limit.",
                    )
                output.write(chunk)

        if size == 0:
            raise HTTPException(status_code=400, detail="The rendered video is empty.")

        return {"filename": filename, "size_bytes": size}
    except HTTPException:
        file_path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        file_path.unlink(missing_ok=True)
        logger.exception("Could not prepare browser-rendered video for YouTube")
        raise HTTPException(
            status_code=500,
            detail="Could not prepare the rendered video.",
        ) from exc
    finally:
        await file.close()


@router.post("/api/youtube/upload")
def start_youtube_upload(
    request: YouTubeUploadRequest,
    background_tasks: BackgroundTasks,
):
    """Queues a completed rendered MP4 for upload to the connected YouTube channel."""
    if not _oauth_configured():
        raise HTTPException(status_code=503, detail="YouTube OAuth is not configured.")
    if _load_credentials() is None:
        raise HTTPException(status_code=401, detail="Connect your YouTube account before uploading.")

    safe_filename = Path(request.filename).name
    if safe_filename != request.filename or safe_filename in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid rendered filename.")

    export_root = EXPORTS_DIR.resolve()
    file_path = (EXPORTS_DIR / safe_filename).resolve()
    try:
        file_path.relative_to(export_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid rendered file path.")

    if file_path.suffix.lower() != ".mp4" or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Completed MP4 file was not found. It may have expired from temporary storage.")

    file_size = file_path.stat().st_size
    if file_size <= 0:
        raise HTTPException(status_code=400, detail="The rendered video file is empty.")
    if file_size > MAX_VIDEO_BYTES:
        raise HTTPException(status_code=413, detail="The video exceeds YouTube's 256 GB upload limit.")

    clean_title = request.title.strip()
    if not clean_title:
        raise HTTPException(status_code=400, detail="Video title cannot be empty.")

    tags = [
        tag.strip()[:100]
        for tag in request.tags
        if tag.strip()
    ][:30]

    upload_id = uuid.uuid4().hex[:12]
    with _JOB_LOCK:
        _UPLOAD_JOBS[upload_id] = {
            "upload_id": upload_id,
            "filename": safe_filename,
            "title": clean_title,
            "status": "queued",
            "progress_percent": 0,
            "message": "Waiting to upload",
            "error": None,
            "video_id": None,
            "watch_url": None,
            "created_at": time.time(),
        }

    background_tasks.add_task(
        _run_youtube_upload,
        upload_id,
        file_path,
        {
            "title": clean_title,
            "description": request.description,
            "tags": tags,
            "privacy_status": request.privacy_status,
        },
    )
    return {"upload_id": upload_id, "status": "queued"}


@router.get("/api/youtube/upload/{upload_id}")
def get_youtube_upload_status(upload_id: str):
    """Returns the progress of one active or recently completed YouTube upload."""
    with _JOB_LOCK:
        job = _UPLOAD_JOBS.get(upload_id)
        if not job:
            raise HTTPException(status_code=404, detail="YouTube upload job not found.")
        return dict(job)
