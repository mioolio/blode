"""Receive an actual JPEG from SerialCamera firmware; never touches flash."""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import re
import sys
import time
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="COM3")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--profile", choices=["EYE", "FREENOVE"], default="EYE")
    parser.add_argument("--resolution", choices=["QVGA", "VGA", "SVGA", "XGA", "UXGA", "QXGA", "QSXGA", "FULL5MP"], default="FULL5MP")
    parser.add_argument("--quality", type=int, default=10, help="JPEG quality code 4-63; lower preserves more detail")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--reset", action="store_true", help="Reset via CH340 RTS before sending commands")
    parser.add_argument("--command", help="Run a single ASCII command instead of a capture")
    args = parser.parse_args()
    if not 4 <= args.quality <= 63:
        parser.error("--quality must be between 4 and 63")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output = args.output or ROOT / "photos" / f"capture-{stamp}.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    log_path = output.with_suffix(".log")
    port = serial.Serial(port=None, baudrate=args.baud, timeout=0.3, write_timeout=5)
    port.dtr = False
    port.rts = False
    port.port = args.port

    with log_path.open("w", encoding="utf-8") as log, port:
        def record(message: str) -> None:
            print(message, flush=True)
            log.write(message + "\n")
            log.flush()

        def send(command: str) -> None:
            record("> " + command)
            port.write((command + "\n").encode("ascii"))
            port.flush()

        def wait_line(prefix: bytes, timeout: float = 20) -> bytes:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                line = port.readline().strip()
                if not line:
                    continue
                record(line.decode("utf-8", errors="replace"))
                if line.startswith(b"ERROR"):
                    raise RuntimeError(line.decode("utf-8", errors="replace"))
                if line.startswith(prefix):
                    return line
            raise TimeoutError(f"Timed out waiting for {prefix!r}")

        if args.reset:
            port.rts = True
            time.sleep(0.15)
            port.rts = False
            time.sleep(1.5)
        port.reset_input_buffer()
        if args.command:
            send(args.command)
            wait_line(b"OK", args.timeout)
            return 0
        send("INFO")
        wait_line(b"OK INFO")
        send("INIT " + args.profile)
        wait_line(b"OK INIT", 30)
        send("SET QUALITY " + str(args.quality))
        wait_line(b"OK SET")
        send("CAPTURE " + args.resolution)
        header = wait_line(b"JPEG ", 45)
        match = re.fullmatch(rb"JPEG (\d+) (\d+) (\d+) ([0-9a-fA-F]{8})", header)
        if not match:
            raise RuntimeError(f"Invalid JPEG header: {header!r}")
        length, width, height = (int(match.group(i)) for i in (1, 2, 3))
        expected_crc = int(match.group(4), 16)
        if not 4 <= length <= 8_000_000:
            raise RuntimeError(f"Invalid JPEG length: {length}")
        data = bytearray()
        deadline = time.monotonic() + max(args.timeout, length * 12 / args.baud + 20)
        while len(data) < length and time.monotonic() < deadline:
            data.extend(port.read(min(16384, length - len(data))))
        if len(data) != length:
            raise TimeoutError(f"Incomplete image: received {len(data)} of {length} bytes")
        trailer = port.read(5)
        if trailer != b"\nEND\n":
            raise RuntimeError(f"Invalid image trailer: {trailer!r}")
        actual_crc = zlib.crc32(data) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise RuntimeError(f"CRC mismatch: {actual_crc:08x} != {expected_crc:08x}")
        if data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
            raise RuntimeError("Missing JPEG SOI/EOI markers")
        output.write_bytes(data)
        record(f"SAVED {output.resolve()} bytes={length} dimensions={width}x{height} crc32={actual_crc:08x}")
        try:
            from PIL import Image
        except ImportError:
            record("Pillow unavailable; transport length, CRC32 and JPEG markers verified")
        else:
            with Image.open(output) as image:
                image.load()
                if image.size != (width, height):
                    raise RuntimeError(f"Decoded image dimensions differ: {image.size}")
                record(f"DECODED JPEG {image.width}x{image.height} mode={image.mode}")
        record(f"LOG {log_path.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAILED: {error}", file=sys.stderr)
        raise SystemExit(1)


