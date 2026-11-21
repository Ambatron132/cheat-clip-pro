"""Local Playwright-based YouTube Studio uploader.

This provider controls a dedicated, persistent Chromium profile on the machine
running the Cheat Clip PRO backend. The user signs into YouTube manually once;
the browser profile is then reused for subsequent uploads.
"""
from __future__ import annotations

import queue
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.config import EXPORTS_DIR, ROOT_DIR, logger

router = APIRouter(tags=["YouTube Browser Upload"])

PROFILE_DIR = ROOT_DIR / "backend" / "youtube_browser_profile"
MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024
_BROWSER_COMMANDS: queue.Queue = queue.Queue()
_BROWSER_JOBS: dict[str, dict] = {}
_BROWSER_LOCK = threading.Lock()
_BROWSER_STATE = {
    "available": True,
    "browser_open": False,
    "connected": False,
    "busy": False,
    "message": "Browser uploader is ready. Open the browser to sign in.",
}
_WORKER: Optional[threading.Thread] = None


class BrowserUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=5000)
    tags: list[str] = Field(default_factory=list)
    privacy_status: Literal["private", "unlisted", "public"] = "private"
    made_for_kids: bool


def _set_browser_state(**updates) -> None:
    with _BROWSER_LOCK:
        _BROWSER_STATE.update(updates)


def _set_job(upload_id: str, **updates) -> None:
    with _BROWSER_LOCK:
        job = _BROWSER_JOBS.get(upload_id)
        if job:
            job.update(updates)


def _is_logged_in(page) -> bool:
    try:
        return "studio.youtube.com" in page.url and "accounts.google.com" not in page.url
    except Exception:
        return False


def _click_text(page, patterns: list[str], timeout: int = 8000) -> None:
    last_error = None
    for pattern in patterns:
        try:
            locator = page.get_by_role("button", name=re.compile(pattern, re.I)).last
            locator.wait_for(state="visible", timeout=timeout)
            locator.click(timeout=timeout)
            return
        except Exception as exc:
            last_error = exc
        try:
            locator = page.get_by_text(re.compile(pattern, re.I)).last
            locator.wait_for(state="visible", timeout=1500)
            locator.click(timeout=timeout)
            return
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Could not find the YouTube Studio control: {patterns[0]}") from last_error


def _fill_first(page, selectors: list[str], value: str, timeout: int = 12000) -> None:
    last_error = None
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            locator.wait_for(state="visible", timeout=timeout)
            locator.fill(value, timeout=timeout)
            return
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Could not locate a YouTube Studio field ({selectors[0]}).") from last_error


def _run_studio_upload(page, upload_id: str, file_path: Path, payload: dict) -> None:
    def progress(percent: int, message: str) -> None:
        _set_job(upload_id, status="uploading", progress_percent=percent, message=message)

    progress(3, "Opening YouTube Studio")
    page.goto("https://studio.youtube.com", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(1200)
    if not _is_logged_in(page):
        raise RuntimeError("YouTube is not signed in. Sign in using the opened browser, then try again.")

    progress(8, "Opening the video upload form")
    _click_text(page, [r"Create|Buat"])
    _click_text(page, [r"Upload videos|Upload video|Unggah video"])

    file_input = page.locator('input[type="file"]').first
    file_input.wait_for(state="attached", timeout=15000)
    file_input.set_input_files(str(file_path))

    progress(20, "Uploading video file")
    page.locator("#title-textarea #textbox").wait_for(state="visible", timeout=90000)
    page.wait_for_timeout(1200)

    _fill_first(
        page,
        ["#title-textarea #textbox", 'textarea[aria-label*="title" i]', '[contenteditable="true"][aria-label*="title" i]'],
        payload["title"],
    )
    _fill_first(
        page,
        ["#description-textarea #textbox", 'textarea[aria-label*="description" i]', '[contenteditable="true"][aria-label*="description" i]'],
        payload.get("description", ""),
    )

    progress(38, "Adding video details")
    # Tags are optional. Expand the advanced details area when it is available.
    try:
        _click_text(page, [r"Show more|Tampilkan lebih banyak"], timeout=2500)
    except Exception:
        pass
    tags = [str(tag).strip()[:100] for tag in payload.get("tags", []) if str(tag).strip()][:30]
    if tags:
        tag_input = None
        for selector in ['#tags-container input', 'input[aria-label*="tag" i]', 'input[placeholder*="tag" i]']:
            try:
                candidate = page.locator(selector).first
                candidate.wait_for(state="visible", timeout=2500)
                tag_input = candidate
                break
            except Exception:
                continue
        if tag_input is None:
            raise RuntimeError("YouTube Studio did not expose the tags field. The video has not been published.")
        for tag in tags:
            tag_input.fill(tag)
            tag_input.press("Enter")

    progress(48, "Setting audience")
    audience_label = (
        "Yes, it's made for kids" if payload["made_for_kids"]
        else "No, it's not made for kids"
    )
    _click_text(page, [re.escape(audience_label)], timeout=10000)

    for step in range(3):
        progress(55 + step * 8, f"Completing upload details ({step + 1}/3)")
        _click_text(page, [r"Next|Berikutnya"], timeout=15000)
        page.wait_for_timeout(700)

    progress(82, "Setting visibility")
    privacy_label = {
        "public": r"Public|Publik",
        "unlisted": r"Unlisted|Tidak publik",
        "private": r"Private|Pribadi",
    }[payload["privacy_status"]]
    _click_text(page, [privacy_label], timeout=10000)

    progress(88, "Publishing video")
    final_action = [r"Publish|Publikasikan"] if payload["privacy_status"] != "private" else [r"Save|Simpan"]
    _click_text(page, final_action, timeout=15000)

    progress(94, "Waiting for YouTube Studio confirmation")
    success_patterns = [
        r"Video published|Video berhasil dipublikasikan",
        r"Video saved|Video disimpan",
        r"Upload complete|Upload selesai",
    ]
    deadline = time.monotonic() + 120
    confirmed = False
    while time.monotonic() < deadline:
        try:
            for pattern in success_patterns:
                if page.get_by_text(re.compile(pattern, re.I)).count() > 0:
                    confirmed = True
                    break
        except Exception:
            pass
        if confirmed:
            break
        page.wait_for_timeout(1000)

    if not confirmed:
        raise RuntimeError(
            "YouTube did not show a publish/save confirmation within 2 minutes. "
            "Check YouTube Studio before retrying to avoid a duplicate upload."
        )

    watch_url = None
    try:
        links = page.locator('a[href*="watch?v="]')
        for index in range(min(links.count(), 20)):
            href = links.nth(index).get_attribute("href")
            if href and "watch?v=" in href:
                watch_url = href if href.startswith("http") else "https://www.youtube.com" + href
                break
    except Exception:
        pass

    _set_job(
        upload_id,
        status="completed",
        progress_percent=100,
        message="YouTube confirmed the video was published/saved.",
        watch_url=watch_url,
    )


def _browser_worker() -> None:
    context = None
    page = None
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            while True:
                try:
                    command = _BROWSER_COMMANDS.get(timeout=1)
                except queue.Empty:
                    if context is not None and page is not None:
                        _set_browser_state(connected=_is_logged_in(page))
                    continue

                if command["type"] == "open":
                    if context is None:
                        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
                        context = playwright.chromium.launch_persistent_context(
                            user_data_dir=str(PROFILE_DIR),
                            headless=False,
                            viewport={"width": 1440, "height": 960},
                        )
                        page = context.pages[0] if context.pages else context.new_page()
                    if page is None or page.is_closed():
                        page = context.new_page()
                    page.goto("https://studio.youtube.com", wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_timeout(1500)
                    connected = _is_logged_in(page)
                    _set_browser_state(
                        browser_open=True,
                        connected=connected,
                        message="YouTube Studio is open. Sign in manually if prompted.",
                    )
                    continue

                if command["type"] == "upload":
                    upload_id = command["upload_id"]
                    try:
                        if context is None:
                            raise RuntimeError("Open the YouTube browser and sign in before uploading.")
                        if page is None or page.is_closed():
                            page = context.new_page()
                        if not _is_logged_in(page):
                            page.goto("https://studio.youtube.com", wait_until="domcontentloaded", timeout=60000)
                            page.wait_for_timeout(1000)
                        if not _is_logged_in(page):
                            raise RuntimeError("YouTube is not signed in. Open the browser, sign in, and try again.")
                        _set_browser_state(busy=True, connected=True, message="Uploading through YouTube Studio.")
                        _run_studio_upload(page, upload_id, command["file_path"], command["payload"])
                    except Exception as exc:
                        logger.exception("Playwright YouTube upload failed for job %s", upload_id)
                        _set_job(
                            upload_id,
                            status="failed",
                            progress_percent=0,
                            message="Browser upload failed",
                            error=str(exc)[:500],
                        )
                    finally:
                        _set_browser_state(busy=False, connected=bool(page and _is_logged_in(page)))
    except Exception as exc:
        logger.exception("YouTube Playwright worker stopped")
        _set_browser_state(
            available=False,
            browser_open=False,
            connected=False,
            busy=False,
            message=f"Playwright is unavailable: {str(exc)[:250]}",
        )


def _ensure_worker() -> None:
    global _WORKER
    if _WORKER is None or not _WORKER.is_alive():
        _set_browser_state(available=True, message="Starting the Playwright browser worker.")
        _WORKER = threading.Thread(target=_browser_worker, name="youtube-playwright", daemon=True)
        _WORKER.start()


@router.get("/api/youtube/browser/status")
def browser_upload_status():
    with _BROWSER_LOCK:
        return dict(_BROWSER_STATE)


@router.post("/api/youtube/browser/connect")
def connect_browser_upload():
    _ensure_worker()
    _BROWSER_COMMANDS.put({"type": "open"})
    return {"success": True, "message": "Opening YouTube Studio in the Playwright browser."}


@router.post("/api/youtube/browser/upload")
def start_browser_upload(request: BrowserUploadRequest):
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
        raise HTTPException(status_code=404, detail="Completed MP4 file was not found.")
    size = file_path.stat().st_size
    if size <= 0 or size > MAX_VIDEO_BYTES:
        raise HTTPException(status_code=400, detail="The rendered video file is empty or exceeds YouTube's 256 GB limit.")

    with _BROWSER_LOCK:
        if not _BROWSER_STATE["browser_open"] or not _BROWSER_STATE["connected"]:
            raise HTTPException(status_code=401, detail="Open Browser Upload and sign in to YouTube Studio first.")
        if _BROWSER_STATE["busy"]:
            raise HTTPException(status_code=409, detail="The Playwright browser is already uploading another video.")

    upload_id = uuid.uuid4().hex[:12]
    with _BROWSER_LOCK:
        _BROWSER_JOBS[upload_id] = {
            "upload_id": upload_id,
            "filename": safe_filename,
            "title": request.title.strip(),
            "status": "queued",
            "progress_percent": 0,
            "message": "Waiting for the browser uploader",
            "error": None,
            "watch_url": None,
            "created_at": time.time(),
        }

    _BROWSER_COMMANDS.put({
        "type": "upload",
        "upload_id": upload_id,
        "file_path": file_path,
        "payload": request.model_dump(),
    })
    return {"upload_id": upload_id, "status": "queued"}


@router.get("/api/youtube/browser/upload/{upload_id}")
def get_browser_upload_job(upload_id: str):
    with _BROWSER_LOCK:
        job = _BROWSER_JOBS.get(upload_id)
        if not job:
            raise HTTPException(status_code=404, detail="Browser upload job not found.")
        return dict(job)
