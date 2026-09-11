#!/usr/bin/env python3
"""Local-only server for the GPX Motion application."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = APP_DIR / "settings.json"
OUT_DIR = APP_DIR.parent / "out"
ALLOWED_SETTINGS = {
    "mapbox_token", "map_labels", "seconds", "fps", "quality", "render_mode",
    "metric", "orientation", "hud_top", "font_scale", "label_font_scale",
    "route_color", "route_color_mode", "show_heart_rate", "camera_distance",
    "camera_height",
}

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/javascript", ".js")


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def load_settings() -> dict:
    current = load_json(SETTINGS_PATH)
    return {key: current[key] for key in ALLOWED_SETTINGS if key in current}


def unique_output_path(stem: str, suffix: str) -> Path:
    candidate = OUT_DIR / f"{stem}{suffix}"
    counter = 2
    while candidate.exists():
        candidate = OUT_DIR / f"{stem}_{counter}{suffix}"
        counter += 1
    return candidate


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/settings":
            payload = json.dumps(load_settings()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/video":
            self.save_video(parsed)
            return
        if parsed.path != "/api/settings":
            self.send_error(404)
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 65536)
            submitted = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(submitted, dict):
                raise ValueError("Settings must be an object")
            clean = {key: submitted[key] for key in ALLOWED_SETTINGS if key in submitted}
            SETTINGS_PATH.write_text(json.dumps(clean, indent=2), encoding="utf-8")
            try:
                SETTINGS_PATH.chmod(0o600)
            except OSError:
                pass
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            self.send_error(400, str(error))

    def save_video(self, parsed):
        temp_path = None
        conversion_path = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024 * 1024:
                raise ValueError("Invalid video size")
            query = parse_qs(parsed.query)
            requested = query.get("filename", ["activity_3D.mp4"])[0]
            prefer_mp4 = query.get("prefer_mp4", ["0"])[0] == "1"
            try:
                fps = max(1.0, min(120.0, float(query.get("fps", ["30"])[0])))
            except (TypeError, ValueError):
                fps = 30.0
            stem = re.sub(r"[^A-Za-z0-9._ -]+", "", Path(requested).stem).strip()[:100] or "activity_3D"
            suffix = Path(requested).suffix.lower()
            if suffix not in {".mp4", ".webm"}:
                suffix = ".mp4"
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            temp_path = OUT_DIR / f".{stem}.{uuid.uuid4().hex}.upload{suffix}"
            remaining = length
            with temp_path.open("wb") as output:
                while remaining:
                    block = self.rfile.read(min(1024 * 1024, remaining))
                    if not block:
                        raise ConnectionError("The video upload ended early")
                    output.write(block)
                    remaining -= len(block)

            warning = ""
            converted = False
            if suffix == ".webm" and prefer_mp4:
                ffmpeg = shutil.which("ffmpeg")
                if ffmpeg:
                    final_path = unique_output_path(stem, ".mp4")
                    conversion_path = OUT_DIR / f".{stem}.{uuid.uuid4().hex}.part.mp4"
                    command = [
                        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                        "-i", str(temp_path), "-an", "-c:v", "libx264",
                        "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                        "-r", f"{fps:g}", "-movflags", "+faststart", str(conversion_path),
                    ]
                    conversion = subprocess.run(
                        command,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        text=True,
                        check=False,
                    )
                    if conversion.returncode == 0 and conversion_path.exists() and conversion_path.stat().st_size:
                        conversion_path.replace(final_path)
                        conversion_path = None
                        temp_path.unlink(missing_ok=True)
                        temp_path = None
                        converted = True
                    else:
                        conversion_path.unlink(missing_ok=True)
                        conversion_path = None
                        final_path = unique_output_path(stem, ".webm")
                        temp_path.replace(final_path)
                        temp_path = None
                        warning = "FFmpeg could not create MP4; a smooth seekable WebM was saved instead."
                else:
                    final_path = unique_output_path(stem, ".webm")
                    temp_path.replace(final_path)
                    temp_path = None
                    warning = "FFmpeg was not found; a smooth seekable WebM was saved instead."
            else:
                final_path = unique_output_path(stem, suffix)
                temp_path.replace(final_path)
                temp_path = None

            payload = json.dumps({
                "ok": True,
                "path": str(final_path),
                "format": final_path.suffix.lstrip("."),
                "converted": converted,
                "size": final_path.stat().st_size,
                "warning": warning,
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            if conversion_path is not None:
                try:
                    conversion_path.unlink(missing_ok=True)
                except OSError:
                    pass
            self.send_error(400, str(error))

    def log_message(self, format_string, *args):
        if self.path.startswith("/api/"):
            return
        super().log_message(format_string, *args)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"GPX Motion is running at {url}", flush=True)
    print("Close this window or press Control-C to stop it.", flush=True)
    threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
