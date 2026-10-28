"""Loopback-only web console for the USB-connected ESP32-S3 camera."""
from __future__ import annotations

import argparse
import atexit
import copy
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from pathlib import Path
import re
import socket
import sys
import threading
import time
from urllib.parse import parse_qs, quote, urlparse
import zlib

ROOT = Path(__file__).resolve().parent
for base in (ROOT, *ROOT.parents):
    candidate = base / 'tools' / 'python' / 'Lib' / 'site-packages'
    if candidate.exists():
        sys.path.insert(0, str(candidate))
        break
legacy = ROOT.parent / '.tools' / 'python'
if legacy.exists():
    sys.path.insert(0, str(legacy))
import serial
from serial.tools import list_ports

LOG = logging.getLogger("camera-console")
RANGES = {
    "brightness": (-3, 3), "contrast": (-3, 3), "saturation": (-4, 4),
    "sharpness": (-3, 3), "denoise": (0, 8), "lenc": (0, 1),
    "whitebal": (0, 1), "awb_gain": (0, 1), "wb_mode": (0, 4),
    "gain_ctrl": (0, 1), "exposure_ctrl": (0, 1), "aec2": (0, 1),
    "ae_level": (-5, 5), "gainceiling": (16, 1023),
    "agc_gain": (0, 64), "aec_value": (0, 1200), "quality": (4, 63),
}
ORDER = ["brightness", "contrast", "saturation", "sharpness", "denoise", "lenc",
         "gainceiling", "ae_level", "aec2", "agc_gain", "aec_value",
         "gain_ctrl", "exposure_ctrl", "whitebal", "awb_gain", "wb_mode", "quality"]


class CameraError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


class ProtocolError(Exception):
    pass


def pairs(line: str) -> dict:
    # Values such as chip=ESP32-S3 contain no spaces; INFO chip text is retained too.
    result = {}
    for key, value in re.findall(r"([A-Za-z_][A-Za-z_0-9]*)=([^\s]+)", line):
        try:
            result[key] = int(value, 16 if value.lower().startswith("0x") else 10)
        except ValueError:
            result[key] = value
    return result


class Camera:
    def __init__(self, port: str = "COM3", preferred_baud: int = 460800):
        self.serial_lock = threading.RLock()
        self.state_lock = threading.RLock()
        self.port = None
        self.preferred_baud = preferred_baud
        self.current_quality = None
        self.preview_quality = 24
        self.photo_quality = 12
        self._preview_cache = None
        self.settings_path = ROOT / "web-settings.json"
        self._state = {
            "app_id": "esp32-camera-console", "connected": False, "port": port,
            "baud": 115200, "sensor": None, "info": {}, "settings": {},
            "wb_gains": {"r": 1024, "g": 1024, "b": 1024},
            "wb_manual": False, "wb_custom": False, "last_error": None,
            "last_photo": None, "busy": None, "preview_quality": 24, "photo_quality": 12,
        }

    def state(self):
        with self.state_lock:
            return copy.deepcopy(self._state)

    def update(self, **values):
        with self.state_lock:
            self._state.update(values)

    def close(self):
        with self.serial_lock:
            self._close()

    def _close(self):
        self._preview_cache = None
        if self.port is not None:
            try:
                self.port.close()
            except Exception:
                pass
        self.port = None
        self.current_quality = None
        self.update(connected=False, baud=115200)

    @contextmanager
    def operation(self, label, require=True):
        with self.serial_lock:
            if require and (not self.port or not self.port.is_open or not self.state()["connected"]):
                raise CameraError("摄像头未连接，请先选择串口并连接。")
            self.update(busy=label)
            try:
                yield
                self.update(last_error=None)
            except CameraError as error:
                self.update(last_error=str(error))
                raise
            except (serial.SerialException, OSError, TimeoutError, ProtocolError) as error:
                self._close()
                message = f"摄像头通信中断：{error}。请检查 USB 连接后重新连接。"
                self.update(last_error=message)
                raise CameraError(message, 503) from error
            finally:
                self.update(busy=None)

    def command(self, command: str, prefix: str | None = None, timeout=15):
        self.port.write((command + "\n").encode("ascii"))
        self.port.flush()
        deadline = time.monotonic() + timeout
        lines = []
        expected = prefix or "OK " + command.split(" ", 1)[0]
        while time.monotonic() < deadline:
            line = self.port.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if line.startswith("ERROR"):
                raise CameraError("设备返回：" + line, 400)
            lines.append(line)
            if line.startswith(expected):
                return lines
        raise TimeoutError(f"等待 {expected} 超时")

    def status(self):
        lines = self.command("STATUS")
        settings, gains = {}, {}
        for line in lines:
            if line.startswith("STATUS "):
                settings.update(pairs(line))
            elif line.startswith("GAINS "):
                gains.update(pairs(line))
        state = self.state()
        state["settings"].update({name: settings[name] for name in RANGES if name in settings})
        if "quality" in settings:
            self.current_quality = settings["quality"]
        state["wb_custom"] = bool(settings.get("wbgain_custom", 0))
        if gains:
            state["wb_gains"] = {channel: int(gains[channel]) for channel in ("r", "g", "b")}
            state["wb_manual"] = bool(gains.get("wb_manual"))
            state["settings"]["gainceiling"] = int(gains["gain_ceiling_raw"])
            state["settings"]["lenc"] = int(gains["lenc_enabled"])
            state["info"]["analog_gain_raw"] = gains.get("analog_raw")
            state["info"]["analog_gain_x"] = round(gains.get("analog_raw", 0) / 16, 2)
        self.update(settings=state["settings"], wb_gains=state["wb_gains"],
                    wb_manual=state["wb_manual"], wb_custom=state["wb_custom"], info=state["info"])

    def connect(self, device=None, load_saved=True):
        with self.operation("连接摄像头", require=False):
            self._close()
            device = device or self.state()["port"]
            if not isinstance(device, str) or not re.fullmatch(r"COM\d+", device, re.I):
                raise CameraError("请选择有效的 COM 串口。", 400)
            self.update(port=device.upper(), sensor=None, settings={}, wb_manual=False, wb_custom=False)
            port = serial.Serial(port=None, baudrate=115200, timeout=0.25, write_timeout=5)
            port.dtr = False
            port.rts = False
            port.port = device
            self.port = port
            selected_baud = self.preferred_baud
            baud_confirmed = False
            try:
                port.open()
                port.rts = True
                time.sleep(0.15)
                port.rts = False
                time.sleep(1.5)
                port.reset_input_buffer()
                info_lines = self.command("INFO")
                info = {}
                for line in info_lines:
                    if line.startswith("INFO "):
                        info.update(pairs(line))
                init_lines = self.command("INIT EYE", timeout=35)
                for line in init_lines:
                    info.update(pairs(line))
                sensor_pid = info.get("sensor_pid")
                sensor = {0x5640: "OV5640", 0x3660: "OV3660", 0x77: "OV3660", 0x2642: "OV2640"}.get(sensor_pid)
                if sensor is None:
                    sensor = f"PID 0x{sensor_pid:04x}" if isinstance(sensor_pid, int) else "摄像头"
                self.command(f"BAUD {selected_baud}")
                # Firmware waits 50 ms after its old-rate acknowledgement.
                time.sleep(0.1)
                port.baudrate = selected_baud
                self.update(connected=True, baud=selected_baud, sensor=sensor, info=info)
                self.status()
                baud_confirmed = True
                self.preview_quality = 24
                self.photo_quality = 12
                if load_saved and self.settings_path.exists():
                    saved = json.loads(self.settings_path.read_text(encoding="utf-8"))
                    self.apply(saved.get("settings", {}), saved.get("wb_gains"))
                    photo_quality = saved.get("photo_quality", 12)
                    if type(photo_quality) is int and 4 <= photo_quality <= 63:
                        self.photo_quality = photo_quality
                self.set_quality(self.preview_quality)
                self.update(preview_quality=self.preview_quality, photo_quality=self.photo_quality)
            except Exception:
                self._close()
                if not baud_confirmed and selected_baud != 460800:
                    LOG.warning("Baud %s failed; retrying connection at verified fallback 460800", selected_baud)
                    self.preferred_baud = 460800
                    return self.connect(device, load_saved=load_saved)
                raise
        return self.state()

    def disconnect(self):
        with self.operation("断开连接", require=False):
            self._close()
        return self.state()

    @staticmethod
    def validate(settings, gains):
        if not isinstance(settings, dict):
            raise CameraError("settings 必须是参数对象。", 400)
        for name, value in settings.items():
            if name not in RANGES:
                raise CameraError(f"未知参数：{name}", 400)
            low, high = RANGES[name]
            if type(value) is not int or not low <= value <= high:
                raise CameraError(f"{name} 的范围为 {low}～{high}。", 400)
        if gains is not None:
            if not isinstance(gains, dict) or set(gains) != {"r", "g", "b"}:
                raise CameraError("白平衡增益需要 r、g、b 三个值。", 400)
            if any(type(value) is not int or not 256 <= value <= 4095 for value in gains.values()):
                raise CameraError("RGB 白平衡增益的范围为 256～4095。", 400)

    def apply(self, settings, gains=None):
        self.validate(settings, gains)
        with self.operation("应用参数"):
            self._preview_cache = None
            try:
                for name in ORDER:
                    if name in settings:
                        self.command(f"SET {name} {settings[name]}")
                        if name == "quality":
                            self.current_quality = settings[name]
                            self.preview_quality = settings[name]
                            self.update(preview_quality=self.preview_quality)
                if gains is not None:
                    self.command(f"WBGAIN {gains['r']} {gains['g']} {gains['b']}")
            except CameraError:
                # A rejected command may follow successfully applied ones; reflect the real device.
                if self.port and self.port.is_open:
                    self.status()
                raise
            self.status()
        return self.state()

    def set_quality(self, quality):
        if type(quality) is not int or not 4 <= quality <= 63:
            raise CameraError("JPEG 压缩值的范围为 4～63，数值越低画质越高。", 400)
        if self.current_quality != quality:
            self._preview_cache = None
            self.command(f"SET QUALITY {quality}")
            self.current_quality = quality
            settings = self.state()["settings"]
            settings["quality"] = quality
            self.update(settings=settings)

    def _image(self, resolution, preview=False):
        started = time.perf_counter()
        valid = {"QVGA", "VGA", "SVGA"} if preview else {"QVGA", "VGA", "SVGA", "XGA", "UXGA", "QXGA", "FULL5MP"}
        if resolution not in valid:
            raise CameraError("不支持的图片分辨率。", 400)
        command = ("PREVIEW " if preview else "CAPTURE ") + resolution
        lines = self.command(command, "JPEG ", timeout=50)
        header = lines[-1]
        match = re.fullmatch(r"JPEG (\d+) (\d+) (\d+) ([0-9a-fA-F]{8})", header)
        if not match:
            raise ProtocolError("图片头格式不正确")
        length, width, height = (int(match.group(i)) for i in (1, 2, 3))
        crc = int(match.group(4), 16)
        if not 4 <= length <= 8_000_000:
            raise ProtocolError("图片长度不正确")
        deadline = time.monotonic() + max(20, length * 12 / self.port.baudrate + 12)
        image = bytearray()
        while len(image) < length and time.monotonic() < deadline:
            image.extend(self.port.read(min(65536, length - len(image))))
        if len(image) != length:
            raise ProtocolError(f"图片接收不完整：{len(image)}/{length} 字节")
        trailer = bytearray()
        deadline = time.monotonic() + 3
        while len(trailer) < 5 and time.monotonic() < deadline:
            trailer.extend(self.port.read(5 - len(trailer)))
        if trailer != b"\nEND\n":
            raise ProtocolError("图片结束标记不正确")
        if zlib.crc32(image) & 0xFFFFFFFF != crc:
            raise ProtocolError("图片 CRC32 校验失败")
        if image[:2] != b"\xff\xd8" or image[-2:] != b"\xff\xd9":
            raise ProtocolError("JPEG 文件标记不正确")
        elapsed = time.perf_counter() - started
        self.update(last_frame={"width": width, "height": height, "bytes": length, "crc32": f"{crc:08x}",
                                "elapsed_ms": round(elapsed * 1000, 1), "fps": round(1 / elapsed, 2)})
        return bytes(image), width, height

    def preview(self, resolution="QVGA", quality=None):
        requested_at = time.perf_counter()
        with self.operation("更新预览"):
            quality = self.preview_quality if quality is None else quality
            cached = self._preview_cache
            if (cached is not None and cached["resolution"] == resolution
                    and cached["quality"] == quality and cached["completed_at"] >= requested_at):
                # Concurrent viewers share the frame captured while this request
                # waited for the camera; sequential requests always get a new one.
                self.update(last_frame=cached["metadata"], preview_quality=quality)
                return cached["result"]
            self.set_quality(quality)
            self.preview_quality = quality
            self.update(preview_quality=quality)
            result = self._image(resolution, preview=True)
            self._preview_cache = {"resolution": resolution, "quality": quality,
                                   "completed_at": time.perf_counter(), "result": result,
                                   "metadata": self.state()["last_frame"]}
            return result

    def capture(self, resolution="FULL5MP", quality=None):
        with self.operation("拍摄照片"):
            self._preview_cache = None
            quality = self.photo_quality if quality is None else quality
            if type(quality) is not int or not 4 <= quality <= 63:
                raise CameraError("照片 JPEG 压缩值的范围为 4～63。", 400)
            requested_quality = quality
            before = self.state()
            preview_quality = self.preview_quality
            self.photo_quality = quality
            self.update(photo_quality=quality)
            try:
                self.set_quality(quality)
                try:
                    image, width, height = self._image(resolution)
                except CameraError as error:
                    recoverable = any(message in str(error) for message in
                                      ("ERROR CAPTURE no_frame", "ERROR CAPTURE invalid_jpeg"))
                    if not recoverable:
                        raise
                    if resolution == "FULL5MP":
                        quality = min(63, max(requested_quality + 4, 14))
                        LOG.warning("Full 5MP frame unavailable; reduce buffer pressure by retrying JPEG quality %s instead of %s while keeping 2592x1944",
                                    quality, requested_quality)
                    # Preserve unsaved color controls and custom WB across the one recovery.
                    settings = {name: value for name, value in before["settings"].items()
                                if name in RANGES and type(value) is int
                                and RANGES[name][0] <= value <= RANGES[name][1]}
                    gains = before["wb_gains"] if before["wb_custom"] else None
                    self.validate(settings, gains)
                    LOG.warning("Capture frame unavailable; reinitializing once and retaining current settings")
                    self.update(busy="重新初始化摄像头")
                    self.connect(before["port"], load_saved=False)
                    self.apply(settings, gains)
                    self.set_quality(quality)
                    self.photo_quality = quality
                    self.update(photo_quality=quality, busy="重试拍摄照片")
                    image, width, height = self._image(resolution)
                folder = ROOT / "photos"
                folder.mkdir(exist_ok=True)
                filename = datetime.now().strftime("web-photo-%Y%m%d-%H%M%S-%f.jpg")
                (folder / filename).write_bytes(image)
                photo = {"url": "/photos/" + quote(filename), "filename": filename,
                         "width": width, "height": height, "bytes": len(image), "quality": quality,
                         "requested_quality": requested_quality}
                self.update(last_photo=photo)
                self.status()
            finally:
                self.preview_quality = preview_quality
                self.update(preview_quality=preview_quality)
                if self.port and self.port.is_open:
                    self.set_quality(preview_quality)
        return {"ok": True, **photo, "state": self.state()}

    def save(self, photo_quality=None):
        with self.operation("保存参数"):
            if photo_quality is not None:
                if type(photo_quality) is not int or not 4 <= photo_quality <= 63:
                    raise CameraError("照片 JPEG 压缩值的范围为 4～63。", 400)
                self.photo_quality = photo_quality
                self.update(photo_quality=photo_quality)
            self.status()
            state = self.state()
            settings = {name: value for name, value in state["settings"].items()
                        if name in RANGES and type(value) is int and RANGES[name][0] <= value <= RANGES[name][1]}
            saved = {"version": 1, "sensor": state["sensor"], "settings": settings,
                     "wb_gains": state["wb_gains"] if state["wb_custom"] else None,
                     "photo_quality": self.photo_quality,
                     "saved_at": datetime.now().isoformat(timespec="seconds")}
            temporary = self.settings_path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(self.settings_path)
        return {"ok": True, "path": str(self.settings_path), "state": self.state()}

    def reset(self):
        return self.connect(self.state()["port"], load_saved=False)


class Handler(BaseHTTPRequestHandler):
    server_version = "ESP32CameraConsole/1.0"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        # Continuous preview requests should not flood the launcher log.
        if len(args) > 1 and str(args[1]) not in ("200", "204"):
            LOG.info(fmt, *args)

    @property
    def camera(self):
        return self.server.camera

    def send_data(self, body, content_type, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def json(self, value, status=200):
        self.send_data(json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and parsed.port == self.server.server_port

    def do_GET(self):
        try:
            self.get()
        except CameraError as error:
            self.json({"error": str(error), "state": self.camera.state()}, error.status)
        except Exception:
            LOG.exception("GET failed")
            self.json({"error": "本地服务暂时出错，请重试。"}, 500)

    def get(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query, keep_blank_values=True)
        if path == "/api/state":
            return self.json(self.camera.state())
        if path == "/api/ports":
            return self.json({"ports": [{"device": p.device, "description": p.description}
                                         for p in list_ports.comports()]})
        if path == "/api/preview.jpg":
            raw_quality = query.get("quality", [None])[0]
            try:
                quality = int(raw_quality) if raw_quality is not None else None
            except ValueError:
                raise CameraError("预览 JPEG 压缩值必须是整数。", 400)
            image, width, height = self.camera.preview(query.get("size", ["QVGA"])[0].upper(), quality)
            frame = self.camera.state().get("last_frame", {})
            return self.send_data(image, "image/jpeg", extra={"X-Image-Width": str(width), "X-Image-Height": str(height),
                                  "X-Capture-Ms": str(frame.get("elapsed_ms", 0)), "X-Image-Bytes": str(len(image)),
                                  "X-Camera-Fps": str(frame.get("fps", 0))})
        if path == "/favicon.ico":
            return self.send_data(b"", "image/x-icon", 204)
        if path.startswith("/photos/"):
            name = path.removeprefix("/photos/")
            if not re.fullmatch(r"[A-Za-z0-9._-]+\.jpg", name, re.I):
                raise CameraError("照片路径无效。", 404)
            file = ROOT / "photos" / name
            if not file.is_file():
                raise CameraError("照片不存在。", 404)
            extra = {"Content-Disposition": f'attachment; filename="{name}"'} if "download" in query else None
            return self.send_data(file.read_bytes(), "image/jpeg", extra=extra)
        if path in ("/", "/index.html"):
            file = ROOT / "web" / "index.html"
            if not file.exists():
                return self.send_data("网页正在准备中，请稍后刷新。".encode("utf-8"), "text/plain; charset=utf-8", 503)
            return self.send_data(file.read_bytes(), "text/html; charset=utf-8")
        raise CameraError("页面不存在。", 404)

    def do_POST(self):
        try:
            if not self.same_origin():
                raise CameraError("仅允许本机控制台发起操作。", 403)
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 8192:
                raise CameraError("请求内容过大。", 400)
            raw = self.rfile.read(length)
            data = json.loads(raw) if raw else {}
            if not isinstance(data, dict):
                raise CameraError("请求必须是 JSON 对象。", 400)
            path = urlparse(self.path).path
            if path == "/api/connect":
                result = self.camera.connect(data.get("port"))
            elif path == "/api/disconnect":
                result = self.camera.disconnect()
            elif path == "/api/settings":
                result = self.camera.apply(data.get("settings", {}), data.get("wb_gains"))
            elif path == "/api/capture":
                resolution = data.get("resolution", "FULL5MP")
                if not isinstance(resolution, str):
                    raise CameraError("分辨率无效。", 400)
                result = self.camera.capture(resolution.upper(), data.get("quality"))
            elif path == "/api/save":
                result = self.camera.save(data.get("photo_quality"))
            elif path == "/api/reset":
                result = self.camera.reset()
            else:
                raise CameraError("接口不存在。", 404)
            self.json(result)
        except CameraError as error:
            self.json({"error": str(error), "state": self.camera.state()}, error.status)
        except (ValueError, UnicodeDecodeError):
            self.json({"error": "请求格式不正确。"}, 400)
        except Exception:
            LOG.exception("POST failed")
            self.json({"error": "本地服务暂时出错，请重试。", "state": self.camera.state()}, 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-port", type=int, default=8765)
    parser.add_argument("--port", default="COM3", help="Camera serial port")
    parser.add_argument("--baud", type=int, default=460800,
                        choices=[115200, 230400, 460800, 921600, 1000000, 1500000, 2000000],
                        help="Preferred camera baud rate; automatically falls back to 460800 if connection fails")
    parser.add_argument("--no-auto-connect", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    camera = Camera(args.port, preferred_baud=args.baud)
    atexit.register(camera.close)
    server = Server(("127.0.0.1", args.http_port), Handler)
    server.camera = camera

    def auto_connect():
        try:
            camera.connect(args.port)
            LOG.info("Camera connected on %s", args.port)
        except Exception as error:
            camera.update(last_error=str(error))
            LOG.warning("Camera not connected: %s", error)

    if not args.no_auto_connect:
        threading.Thread(target=auto_connect, daemon=True, name="camera-connect").start()
    print(f"Camera console: http://127.0.0.1:{args.http_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        camera.close()


if __name__ == "__main__":
    main()


