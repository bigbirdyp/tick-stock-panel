#!/bin/sh
# Python is already part of the runtime; use it to supervise both process groups.
exec python3 - <<'PY'
import os
import re
import signal
import subprocess
import sys
import threading
import time

PUBLIC_PORT = 3018
SHUTDOWN_SECONDS = 5
raw_port = os.environ.get("TRADE_JOURNAL_PORT") or "3022"
if not re.fullmatch(r"[1-9][0-9]*", raw_port) or not 1 <= int(raw_port) <= 65535:
    sys.exit("TRADE_JOURNAL_PORT must be a valid TCP port")
if int(raw_port) == PUBLIC_PORT:
    sys.exit("TRADE_JOURNAL_PORT must differ from the public backend port")
os.environ["PORT"] = str(PUBLIC_PORT)
os.environ["TRADE_JOURNAL_PORT"] = raw_port
if not os.environ.get("TRADE_JOURNAL_DATA_FILE"):
    os.environ["TRADE_JOURNAL_DATA_FILE"] = "/app/data/trade-journal/journal.json"

children = []
stop_signal = 0
wakeup = threading.Event()


def request_stop(signum, _frame):
    global stop_signal
    if not stop_signal:
        stop_signal = signum
    wakeup.set()


def signal_group(child, signum):
    try:
        os.killpg(child.pid, signum)
    except ProcessLookupError:
        pass


def shutdown(signum):
    # Signal the entire group: uv may have a Python child rather than exec it.
    for child in children:
        signal_group(child, signum)
    deadline = time.monotonic() + SHUTDOWN_SECONDS
    while any(child.poll() is None for child in children) and time.monotonic() < deadline:
        wakeup.wait(0.05)
        wakeup.clear()
    for child in children:
        signal_group(child, signal.SIGKILL)
        child.wait()
    # As container PID 1 we also adopt and reap terminated descendants.
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not pid:
            break


signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGINT, request_stop)
exit_code = 1
try:
    commands = [
        ["node", "/app/trade-journal-node/src/index.js"],
        ["uv", "run", "--no-sync", "python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", str(PUBLIC_PORT)],
    ]
    for command in commands:
        if stop_signal:
            break
        children.append(subprocess.Popen(command, start_new_session=True))
    while not stop_signal:
        if any(child.poll() is not None for child in children):
            print("A required service exited; stopping the container", file=sys.stderr)
            break
        wakeup.wait(0.1)
        wakeup.clear()
    if stop_signal:
        exit_code = 128 + stop_signal
except OSError as error:
    print(f"Cannot start required service: {error.strerror}", file=sys.stderr)
finally:
    shutdown(stop_signal or signal.SIGTERM)
sys.exit(exit_code)
PY
