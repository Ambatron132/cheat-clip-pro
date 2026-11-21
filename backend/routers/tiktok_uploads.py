"""TikTok OAuth and Content Posting API draft-upload endpoints."""

import base64
import hashlib
import json
import math
import os
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

import requests
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from backend.config import EXPORTS_DIR, ROOT_DIR, logger

router = APIRouter(tags=["TikTok Upload"])

TIKTOK_SCOPES = "video.upload"
TIKTOK_API = "https://open.tiktokapis.com"
MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024
MAX_CHUNK_BYTES = 64 * 1024 * 1024
TOKEN_PATH = Path(
    os.environ.get(
        "TIKTOK_TOKEN_PATH",
        str(ROOT_DIR / "backend" / "tiktok_auth" / "token.json"),
    )
)

_OAUTH_FLOWS: dict[str, tuple[str, float]] = {}
_UPLOAD_JOBS: dict[str, dict] = {}
_JOB_LOCK = threading.Lock()


class TikTokUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)


def _tiktok_settings() -> dict[str, str]:
    settings = {
        "TIKTOK_CLIENT_KEY": os.environ.get("TIKTOK_CLIENT_KEY", "").strip(),
        "TIKTOK_CLIENT_SECRET": os.environ.get("TIKTOK_CLIENT_SECRET", "").strip(),
        "TIKTOK_REDIRECT_URI": os.environ.get("TIKTOK_REDIRECT_URI", "").strip(),
        "TIKTOK_TOKEN_PATH": os.environ.get("TIKTOK_TOKEN_PATH", "").strip(),
    }
    try:
        from dotenv import dotenv_values

        for env_path in (ROOT_DIR / "backend" / ".env", ROOT_DIR / ".env"):
            file_values = dotenv_values(env_path)
            for key in settings:
                if not settings[key]:
                    settings[key] = str(file_values.get(key) or "").strip()
    except Exception as exc:
        logger.warning("Could not read TikTok OAuth environment files: %s", exc)

    if not settings["TIKTOK_REDIRECT_URI"]:
        settings["TIKTOK_REDIRECT_URI"] = "http://localhost:8000/api/tiktok/callback"
    if not settings["TIKTOK_TOKEN_PATH"]:
        settings["TIKTOK_TOKEN_PATH"] = str(ROOT_DIR / "backend" / "tiktok_auth" / "token.json")
    return settings


def _oauth_configured() -> bool:
    settings = _tiktok_settings()
    return bool(settings["TIKTOK_CLIENT_KEY"] and settings["TIKTOK_CLIENT_SECRET"])


def _token_path() -> Path:
    return Path(_tiktok_settings()["TIKTOK_TOKEN_PATH"])


def _save_token(token: dict) -> None:
    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(token, indent=2), encoding="utf-8")
    os.replace(temp_path, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _read_token() -> Optional[dict]:
    path = _token_path()
    if not path.is_file():
        return None
    try:
        token = json.loads(path.read_text(encoding="utf-8"))
        return token if isinstance(token, dict) and token.get("access_token") else None
    except Exception as exc:
        logger.warning("Unable to read TikTok token file: %s", exc)
        return None


def _post_token_form(data: dict) -> dict:
    response = requests.post(
        f"{TIKTOK_API}/v2/oauth/token/",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
        timeout=30,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if not response.ok or payload.get("error"):
        message = payload.get("error_description") or payload.get("message") or f"HTTP {response.status_code}"
        raise RuntimeError(f"TikTok OAuth failed: {message}")
    if not payload.get("access_token"):
        raise RuntimeError("TikTok did not return an access token.")
    return payload


def _store_token_response(payload: dict, previous: Optional[dict] = None) -> dict:
    now = time.time()
    token = dict(previous or {})
    token.update(payload)
    token["expires_at"] = now + int(payload.get("expires_in", 0))
    if payload.get("refresh_expires_in"):
        token["refresh_expires_at"] = now + int(payload["refresh_expires_in"])
    _save_token(token)
    return token


def _get_valid_token() -> Optional[dict]:
    token = _read_token()
    if not token:
        return None

    if float(token.get("expires_at", 0)) > time.time() + 120:
        return token

    refresh_token = token.get("refresh_token")
    settings = _tiktok_settings()
    if not refresh_token or not settings["TIKTOK_CLIENT_KEY"] or not settings["TIKTOK_CLIENT_SECRET"]:
        return None

    refreshed = _post_token_form({
        "client_key": settings["TIKTOK_CLIENT_KEY"],
        "client_secret": settings["TIKTOK_CLIENT_SECRET"],
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    })
    # TikTok rotates refresh tokens. Always persist the newest response.
    return _store_token_response(refreshed, token)


def _api_json(response: requests.Response) -> dict:
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    error = payload.get("error") or {}
    if not response.ok or (isinstance(error, dict) and error.get("code") not in (None, "", "ok")):
        message = error.get("message") if isinstance(error, dict) else str(error)
        raise RuntimeError(message or f"TikTok API returned HTTP {response.status_code}.")
    if not isinstance(payload.get("data"), dict):
        raise RuntimeError("TikTok returned an unexpected API response.")
    return payload["data"]


def _oauth_callback_page(title: str, message: str, success: bool = True) -> HTMLResponse:
    color = "#34d399" if success else "#fca5a5"
    safe_title = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    safe_message = message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return HTMLResponse(
        f"""<!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>{safe_title}</title></head>
        <body style="font-family:system-ui;background:#10131d;color:#f8fafc;display:grid;place-items:center;min-height:90vh;text-align:center">
          <main><h2 style="color:{color}">{safe_title}</h2><p>{safe_message}</p>
          <button onclick="window.close()" style="padding:10px 16px;border:0;border-radius:8px;cursor:pointer">Close window</button></main>
        </body></html>""",
        status_code=200 if success else 400,
    )


@router.get("/api/tiktok/status")
def tiktok_connection_status():
    configured = _oauth_configured()
    connected = False
    scopes = ""
    username = ""
    if configured:
        try:
            token = _get_valid_token()
            connected = token is not None
            if token:
                scopes = str(token.get("scope", ""))
                username = str(token.get("username", ""))
        except Exception as exc:
            logger.warning("TikTok token refresh/check failed: %s", exc)
    return {
        "configured": configured,
        "connected": connected,
        "redirect_uri": _tiktok_settings()["TIKTOK_REDIRECT_URI"],
        "scope": scopes,
        "username": username,
    }


@router.get("/api/tiktok/auth-url")
def tiktok_auth_url():
    if not _oauth_configured():
        raise HTTPException(
            status_code=503,
            detail="TikTok OAuth is not configured. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to backend/.env.",
        )

    settings = _tiktok_settings()
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")

    now = time.time()
    for old_state, (_, created_at) in list(_OAUTH_FLOWS.items()):
        if now - created_at > 600:
            _OAUTH_FLOWS.pop(old_state, None)
    _OAUTH_FLOWS[state] = (verifier, now)

    query = urlencode({
        "client_key": settings["TIKTOK_CLIENT_KEY"],
        "response_type": "code",
        "scope": TIKTOK_SCOPES,
        "redirect_uri": settings["TIKTOK_REDIRECT_URI"],
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    return {
        "authorization_url": f"https://www.tiktok.com/v2/auth/authorize/?{query}",
        "redirect_uri": settings["TIKTOK_REDIRECT_URI"],
    }


@router.get("/api/tiktok/callback", response_class=HTMLResponse)
def tiktok_oauth_callback(
    state: Optional[str] = None,
    code: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
):
    flow_entry = _OAUTH_FLOWS.pop(state or "", None)
    if not flow_entry:
        return _oauth_callback_page("TikTok authorization expired", "Return to Cheat Clip Pro and connect TikTok again.", False)
    if error:
        return _oauth_callback_page("TikTok connection was not completed", error_description or error, False)
    if not code:
        return _oauth_callback_page("TikTok authorization failed", "TikTok did not return an authorization code.", False)

    verifier, created_at = flow_entry
    if time.time() - created_at > 600:
        return _oauth_callback_page("TikTok authorization expired", "Return to Cheat Clip Pro and connect TikTok again.", False)

    settings = _tiktok_settings()
    try:
        payload = _post_token_form({
            "client_key": settings["TIKTOK_CLIENT_KEY"],
            "client_secret": settings["TIKTOK_CLIENT_SECRET"],
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": settings["TIKTOK_REDIRECT_URI"],
            "code_verifier": verifier,
        })
        _store_token_response(payload)
        return _oauth_callback_page(
            "TikTok connected successfully",
            "You can close this window and return to Cheat Clip Pro.",
            True,
        )
    except Exception as exc:
        logger.exception("TikTok OAuth callback failed")
        return _oauth_callback_page("Could not connect TikTok", str(exc)[:300], False)


@router.post("/api/tiktok/disconnect")
def tiktok_disconnect():
    token = _read_token()
    settings = _tiktok_settings()
    if token and _oauth_configured():
        try:
            requests.post(
                f"{TIKTOK_API}/v2/oauth/revoke/",
                data={
                    "client_key": settings["TIKTOK_CLIENT_KEY"],
                    "client_secret": settings["TIKTOK_CLIENT_SECRET"],
                    "token": token.get("access_token", ""),
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=20,
            )
        except requests.RequestException:
            logger.warning("Could not complete TikTok token revocation; removing local token.")
    try:
        _token_path().unlink(missing_ok=True)
        return {"success": True, "connected": False}
    except OSError as exc:
        logger.error("Could not remove TikTok token: %s", exc)
        raise HTTPException(status_code=500, detail="Could not disconnect the TikTok account.")


def _set_job(upload_id: str, **updates) -> None:
    with _JOB_LOCK:
        job = _UPLOAD_JOBS.get(upload_id)
        if job:
            job.update(updates)


def _run_tiktok_upload(upload_id: str, file_path: Path) -> None:
    _set_job(upload_id, status="uploading", progress_percent=0, message="Preparing TikTok upload")
    try:
        token = _get_valid_token()
        if not token:
            raise RuntimeError("TikTok is no longer connected. Reconnect your account and try again.")
        granted_scopes = {scope.strip() for scope in str(token.get("scope", "")).replace(" ", ",").split(",") if scope.strip()}
        if "video.upload" not in granted_scopes:
            raise RuntimeError("Your TikTok app has not been granted the video.upload permission. Request and approve this scope in TikTok for Developers, then reconnect.")

        video_size = file_path.stat().st_size
        if video_size <= 0:
            raise RuntimeError("The rendered video is empty.")
        if video_size > MAX_VIDEO_BYTES:
            raise RuntimeError("TikTok's Content Posting API supports videos up to 4 GB.")

        chunk_count = max(1, math.ceil(video_size / MAX_CHUNK_BYTES))
        chunk_size = video_size if chunk_count == 1 else video_size // chunk_count
        init_response = requests.post(
            f"{TIKTOK_API}/v2/post/publish/inbox/video/init/",
            headers={
                "Authorization": f"Bearer {token['access_token']}",
                "Content-Type": "application/json; charset=UTF-8",
            },
            json={
                "source_info": {
                    "source": "FILE_UPLOAD",
                    "video_size": video_size,
                    "chunk_size": chunk_size,
                    "total_chunk_count": chunk_count,
                }
            },
            timeout=45,
        )
        init_data = _api_json(init_response)
        publish_id = init_data.get("publish_id")
        upload_url = init_data.get("upload_url")
        if not publish_id or not upload_url:
            raise RuntimeError("TikTok did not return the upload session details.")

        uploaded = 0
        with file_path.open("rb") as source:
            for chunk_index in range(chunk_count):
                remaining = video_size - uploaded
                current_chunk_size = min(chunk_size, remaining)
                chunk = source.read(current_chunk_size)
                if not chunk:
                    raise RuntimeError("The rendered video file could not be read completely.")
                first_byte = uploaded
                last_byte = uploaded + len(chunk) - 1
                upload_response = requests.put(
                    upload_url,
                    data=chunk,
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Length": str(len(chunk)),
                        "Content-Range": f"bytes {first_byte}-{last_byte}/{video_size}",
                    },
                    timeout=(30, 300),
                )
                if upload_response.status_code not in (200, 201, 206):
                    raise RuntimeError(f"TikTok media transfer failed with HTTP {upload_response.status_code}.")
                uploaded += len(chunk)
                percent = min(90, int(uploaded / video_size * 90))
                _set_job(
                    upload_id,
                    status="uploading",
                    progress_percent=percent,
                    message=f"Sending video to TikTok: {int(uploaded / video_size * 100)}%",
                )

        _set_job(
            upload_id,
            status="processing",
            progress_percent=95,
            message="TikTok is processing the video.",
            publish_id=publish_id,
        )

        # TikTok processes uploads asynchronously and then places the draft in the creator's inbox.
        for _ in range(30):
            time.sleep(3)
            status_response = requests.post(
                f"{TIKTOK_API}/v2/post/publish/status/fetch/",
                headers={
                    "Authorization": f"Bearer {token['access_token']}",
                    "Content-Type": "application/json; charset=UTF-8",
                },
                json={"publish_id": publish_id},
                timeout=30,
            )
            status_data = _api_json(status_response)
            publish_status = status_data.get("status", "")
            if publish_status == "SEND_TO_USER_INBOX":
                _set_job(
                    upload_id,
                    status="completed",
                    progress_percent=100,
                    message="Video sent to your TikTok inbox. Open TikTok to add a caption and publish.",
                    publish_status=publish_status,
                )
                return
            if publish_status == "FAILED":
                raise RuntimeError(f"TikTok could not process the video: {status_data.get('fail_reason', 'unknown error')}")
            if publish_status == "PUBLISH_COMPLETE":
                _set_job(
                    upload_id,
                    status="completed",
                    progress_percent=100,
                    message="TikTok reports that this video has been published.",
                    publish_status=publish_status,
                )
                return

        _set_job(
            upload_id,
            status="completed",
            progress_percent=100,
            message="TikTok accepted the upload. Check your TikTok inbox notification to finish editing and publish.",
            publish_status="PROCESSING",
        )
    except Exception as exc:
        safe_message = str(exc)[:500] or "TikTok upload failed."
        logger.error("TikTok upload failed for job %s: %s", upload_id, safe_message)
        _set_job(
            upload_id,
            status="failed",
            progress_percent=0,
            message="TikTok upload failed",
            error=safe_message,
        )


@router.post("/api/tiktok/prepare")
async def prepare_tiktok_upload(file: UploadFile = File(...)):
    if not _oauth_configured() or _get_valid_token() is None:
        raise HTTPException(status_code=401, detail="Connect your TikTok account before preparing a video.")

    original_name = Path(file.filename or "clip.mp4").name
    if Path(original_name).suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="Only MP4 videos can be uploaded to TikTok.")

    filename = f"tiktok_{uuid.uuid4().hex[:12]}.mp4"
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    file_path = (EXPORTS_DIR / filename).resolve()
    size = 0
    try:
        file_path.relative_to(EXPORTS_DIR.resolve())
        with file_path.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_VIDEO_BYTES:
                    raise HTTPException(status_code=413, detail="TikTok videos must not exceed 4 GB.")
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The rendered video is empty.")
        return {"filename": filename, "size_bytes": size}
    except HTTPException:
        file_path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        file_path.unlink(missing_ok=True)
        logger.exception("Could not prepare browser-rendered video for TikTok")
        raise HTTPException(status_code=500, detail="Could not prepare the rendered video.") from exc
    finally:
        await file.close()


@router.post("/api/tiktok/upload")
def start_tiktok_upload(request: TikTokUploadRequest, background_tasks: BackgroundTasks):
    if not _oauth_configured():
        raise HTTPException(status_code=503, detail="TikTok OAuth is not configured.")
    token = _get_valid_token()
    if token is None:
        raise HTTPException(status_code=401, detail="Connect your TikTok account before uploading.")

    granted_scopes = {scope.strip() for scope in str(token.get("scope", "")).replace(" ", ",").split(",") if scope.strip()}
    if "video.upload" not in granted_scopes:
        raise HTTPException(
            status_code=403,
            detail="The TikTok account has not granted video.upload. Approve the Content Posting API video.upload scope, then reconnect.",
        )

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
        raise HTTPException(status_code=400, detail="The rendered video is empty.")
    if file_size > MAX_VIDEO_BYTES:
        raise HTTPException(status_code=413, detail="TikTok videos must not exceed 4 GB.")

    upload_id = uuid.uuid4().hex[:12]
    with _JOB_LOCK:
        _UPLOAD_JOBS[upload_id] = {
            "upload_id": upload_id,
            "filename": safe_filename,
            "status": "queued",
            "progress_percent": 0,
            "message": "Waiting to upload",
            "error": None,
            "publish_id": None,
            "publish_status": None,
            "created_at": time.time(),
        }

    background_tasks.add_task(_run_tiktok_upload, upload_id, file_path)
    return {"upload_id": upload_id, "status": "queued"}


@router.get("/api/tiktok/upload/{upload_id}")
def get_tiktok_upload_status(upload_id: str):
    with _JOB_LOCK:
        job = _UPLOAD_JOBS.get(upload_id)
        if not job:
            raise HTTPException(status_code=404, detail="TikTok upload job not found.")
        return dict(job)
