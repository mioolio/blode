"""Start the local USB camera console, then open it in a browser."""
from pathlib import Path
import argparse
import json
import subprocess
import sys
import time
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:8765/"


def python_executable() -> str:
    """Prefer the repository Python environment, then fall back to the current interpreter."""
    for base in (ROOT, *ROOT.parents):
        candidate = base / "tools" / "python" / "Scripts" / "python.exe"
        if candidate.exists():
            return str(candidate)
    legacy = ROOT.parent / ".tools" / "python" / "Scripts" / "python.exe"
    return str(legacy) if legacy.exists() else sys.executable


def running() -> bool:
    try:
        with urlopen(URL + "api/state", timeout=1) as response:
            return json.load(response).get("app_id") == "esp32-camera-console"
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not running():
        with (ROOT / "web-console.log").open("ab", buffering=0) as log:
            child = subprocess.Popen(
                [python_executable(), "-u", str(ROOT / "web_console.py"),
                 "--http-port", "8765", "--port", "COM3"],
                cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        (ROOT / "web-console.pid").write_text(str(child.pid), encoding="ascii")
        for _ in range(80):
            if running():
                break
            if child.poll() is not None:
                raise RuntimeError("Camera console stopped. See web-console.log.")
            time.sleep(0.25)
        else:
            raise RuntimeError("Camera console did not start. See web-console.log.")
    print(URL, flush=True)
    if not args.no_browser:
        webbrowser.open(URL)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
