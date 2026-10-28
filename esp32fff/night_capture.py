"""Take exactly one SNAPNIGHT image; no web preview or automatic retry."""
from datetime import datetime
from pathlib import Path
import io
import json
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
from PIL import Image

port = serial.Serial(port=None, baudrate=115200, timeout=.2, write_timeout=3)
port.dtr = False
port.rts = False
port.port = 'COM3'
lines = []


def read_line(prefix, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = port.readline().strip()
        if not value:
            continue
        message = value.decode(errors='replace')
        print(message, flush=True)
        lines.append(message)
        if value.startswith(b'ERROR'):
            raise RuntimeError(message)
        if value.startswith(prefix):
            return value
    raise TimeoutError('No reply: ' + repr(prefix))


def command(value, prefix=b'OK', seconds=4):
    port.write((value + '\n').encode())
    port.flush()
    return read_line(prefix, seconds)


def main():
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    folder = ROOT / 'photos'
    folder.mkdir(exist_ok=True)
    output = folder / ('night-test-' + stamp + '.jpg')
    port.open()
    try:
        port.rts = True
        time.sleep(.15)
        port.rts = False
        time.sleep(.8)
        port.reset_input_buffer()
        command('INFO', b'OK INFO')
        command('BAUD 460800')
        time.sleep(.15)
        port.baudrate = 460800
        port.write(b'SNAPNIGHT\n')
        port.flush()
        idle = read_line(b'IDLE ', 10)
        if any(value not in idle for value in (b'camera=0', b'clock_low=1', b'standby_verified=1')):
            raise RuntimeError('Camera standby was not confirmed; disconnect USB power')
        header = read_line(b'JPEG ', 3)
        match = re.fullmatch(rb'JPEG (\d+) (\d+) (\d+) ([0-9a-fA-F]{8})', header)
        if not match:
            raise RuntimeError('Bad JPEG header')
        length = int(match[1])
        if not 4 <= length <= 400000:
            raise RuntimeError('Unexpected JPEG length')
        data = bytearray()
        deadline = time.monotonic() + 15
        while len(data) < length and time.monotonic() < deadline:
            data.extend(port.read(length - len(data)))
        if len(data) != length or zlib.crc32(data) != int(match[4], 16):
            raise RuntimeError('Image transfer length or CRC check failed')
        if port.read(5) != b'\nEND\n':
            raise RuntimeError('Image trailer missing')
        picture = Image.open(io.BytesIO(data))
        picture.load()
        if picture.size != (640, 480):
            raise RuntimeError('Unexpected decoded size: ' + str(picture.size))
        output.write_bytes(data)
        command('INFO', b'OK INFO')
        info_lines = [line for line in lines if line.startswith('INFO ')]
        if not info_lines or 'camera=0' not in info_lines[-1]:
            raise RuntimeError('Camera did not remain off')
        metadata = {'path': str(output), 'dimensions': picture.size, 'bytes': length,
                    'crc32': match[4].decode(), 'camera_idle': idle.decode(),
                    'lighting': 'current room lighting; IR illumination unconfirmed',
                    'temperature_measured': False}
        output.with_suffix('.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        print('SAVED ' + str(output), flush=True)
    finally:
        if port.is_open:
            # Reboot into the camera-OFF setup even if the capture/transfer failed.
            port.rts = True
            time.sleep(.15)
            port.rts = False
            port.close()
        output.with_suffix('.log').write_text('\n'.join(lines), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAILED: ' + str(error), file=sys.stderr)
        raise SystemExit(1)


