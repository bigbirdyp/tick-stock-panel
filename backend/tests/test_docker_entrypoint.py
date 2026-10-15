"""Supervisor integration tests use disposable PATH executables and no network."""

import json
import os
import selectors
import signal
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "docker-entrypoint.sh"
MOCK_CHILD = """
import json, os, signal, subprocess, sys
from pathlib import Path
name = Path(sys.argv[0]).name
def stop(signum, frame):
    print(json.dumps({'event': 'stop', 'name': name, 'signal': signum}), flush=True)
    sys.exit(0)
def fail(signum, frame):
    sys.exit(int(os.environ.get('MOCK_EXIT_CODE', '0')))
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGUSR1, fail)
if os.environ.get('MOCK_IGNORE_SIGNALS'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
grandchild_pid = None
if os.environ.get('MOCK_GRANDCHILD'):
    read_fd, write_fd = os.pipe()
    code = (
        "import os,signal,sys; "
        "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "signal.signal(signal.SIGINT,signal.SIG_IGN); "
        "os.write(int(sys.argv[1]),b'1'); os.close(int(sys.argv[1])); "
        "exec('while True: signal.pause()')"
    )
    grandchild = subprocess.Popen(
        [sys.executable, '-c', code, str(write_fd)], pass_fds=(write_fd,),
    )
    os.close(write_fd)
    assert os.read(read_fd, 1) == b'1'
    os.close(read_fd)
    grandchild_pid = grandchild.pid
print(json.dumps({'event': 'ready', 'name': name, 'pid': os.getpid(), 'args': sys.argv[1:],
    'port': os.environ['PORT'], 'journal_port': os.environ['TRADE_JOURNAL_PORT'],
    'data_file': os.environ['TRADE_JOURNAL_DATA_FILE'], 'grandchild_pid': grandchild_pid}),
    flush=True)
while True:
    signal.pause()
"""


@pytest.fixture
def supervisor(tmp_path: Path):
    executables = tmp_path / "bin"
    executables.mkdir()
    (executables / "python3").symlink_to(sys.executable)
    for name in ("node", "uv"):
        script = executables / name
        script.write_text(f"#!{sys.executable}\n{MOCK_CHILD}")
        script.chmod(0o755)
    processes = []

    def start(**overrides: str) -> subprocess.Popen:
        env = os.environ.copy()
        env.pop("TRADE_JOURNAL_PORT", None)
        env.pop("TRADE_JOURNAL_DATA_FILE", None)
        # A broken mock must fail, never fall through to a real node/uv binary.
        env.update(
            PATH=str(executables), PORT="9876", DATA_DIR=str(tmp_path / "data"),
            TICKFLOW_ENV_FILE=str(tmp_path / "absent.env"), **overrides,
        )
        process = subprocess.Popen(
            ["/bin/sh", str(ENTRYPOINT)], env=env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        processes.append(process)
        return process

    yield start
    for process in processes:
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=8)


def ready_children(process: subprocess.Popen) -> dict:
    children = {}
    # One line per child; selectors gives a bounded readiness check without sleeps.
    assert process.stdout is not None
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        for _ in range(2):
            assert selector.select(timeout=5), "mock child did not become ready"
            # Read only this line at the OS boundary, so TextIO buffering cannot
            # hide a second already-ready child from the readiness selector.
            line = bytearray()
            while True:
                byte = os.read(process.stdout.fileno(), 1)
                if not byte or byte == b"\n":
                    break
                line.extend(byte)
            assert line, process.stderr.read() if process.poll() is not None else "child closed stdout"
            child = json.loads(line)
            assert child["event"] == "ready"
            children[child["name"]] = child
    return children


def assert_dead(pid: int) -> None:
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_signal_forwarding_reaps_both_children(supervisor, signum: int) -> None:
    process = supervisor()
    children = ready_children(process)
    process.send_signal(signum)
    output, error = process.communicate(timeout=8)
    assert process.returncode == 128 + signum, error
    stops = [json.loads(line) for line in output.splitlines()]
    assert {(event["name"], event["signal"]) for event in stops} == {
        ("node", signum), ("uv", signum),
    }
    for child in children.values():
        assert_dead(child["pid"])


@pytest.mark.parametrize("failed_child", ["node", "uv"])
@pytest.mark.parametrize("child_exit", ["0", "7"])
def test_child_failure_stops_sibling_and_exits_nonzero(
    supervisor, failed_child: str, child_exit: str,
) -> None:
    process = supervisor(MOCK_EXIT_CODE=child_exit)
    children = ready_children(process)
    os.kill(children[failed_child]["pid"], signal.SIGUSR1)
    output, error = process.communicate(timeout=8)
    assert process.returncode == 1
    assert "required service exited" in error
    sibling = "uv" if failed_child == "node" else "node"
    assert json.loads(output)["name"] == sibling
    for child in children.values():
        assert_dead(child["pid"])


def test_runtime_defaults_and_command_arguments(supervisor) -> None:
    process = supervisor()
    children = ready_children(process)
    assert children["node"]["args"] == ["/app/trade-journal-node/src/index.js"]
    assert children["uv"]["args"] == [
        "run", "--no-sync", "python", "-m", "uvicorn", "app.main:app",
        "--host", "0.0.0.0", "--port", "3018",
    ]
    for child in children.values():
        assert child["port"] == "3018"
        assert child["journal_port"] == "3022"
        assert child["data_file"] == "/app/data/trade-journal/journal.json"


def test_explicit_internal_port_and_persisted_path(supervisor, tmp_path: Path) -> None:
    data_file = str(tmp_path / "saved.json")
    process = supervisor(TRADE_JOURNAL_PORT="4022", TRADE_JOURNAL_DATA_FILE=data_file)
    for child in ready_children(process).values():
        assert child["journal_port"] == "4022"
        assert child["data_file"] == data_file


def test_unresponsive_children_are_killed_within_shutdown_deadline(supervisor) -> None:
    process = supervisor(MOCK_IGNORE_SIGNALS="1")
    children = ready_children(process)
    process.terminate()
    process.communicate(timeout=7)
    assert process.returncode == 128 + signal.SIGTERM
    for child in children.values():
        assert_dead(child["pid"])


@pytest.mark.parametrize("trigger", ["signal", "child_failure"])
def test_descendants_ignoring_term_do_not_survive_process_group_cleanup(
    supervisor, trigger: str,
) -> None:
    process = supervisor(MOCK_GRANDCHILD="1")
    children = ready_children(process)
    try:
        for child in children.values():
            # A real descendant in the service group, not a second direct child.
            assert os.getpgid(child["grandchild_pid"]) == child["pid"]
        if trigger == "signal":
            process.terminate()
        else:
            os.kill(children["uv"]["pid"], signal.SIGUSR1)
        # Grandchildren inherit this stdout/stderr. communicate cannot reach EOF
        # while they survive, even when both direct children have already exited.
        _output, error = process.communicate(timeout=8)
        assert process.returncode == (143 if trigger == "signal" else 1), error
        for child in children.values():
            assert_dead(child["pid"])
            assert_dead(child["grandchild_pid"])
            with pytest.raises(ProcessLookupError):
                os.killpg(child["pid"], 0)
    finally:
        # Keep the harness safe even when a regression leaves a mock family alive.
        # These groups are the recorded PIDs of this test's own session leaders.
        for child in children.values():
            with suppress(ProcessLookupError):
                os.killpg(child["pid"], signal.SIGKILL)


def test_spawn_failure_stops_existing_child(supervisor, tmp_path: Path) -> None:
    # Executable discovery succeeds, but its interpreter is unavailable.
    (tmp_path / "bin" / "uv").write_text("#!/missing-interpreter-for-entrypoint-test\n")
    process = supervisor()
    _output, error = process.communicate(timeout=7)
    assert process.returncode == 1
    assert "Cannot start required service" in error


@pytest.mark.parametrize("port", ["0", "-1", "3018", "65536", "3022x", "03022"])
def test_invalid_port_rejected_before_spawning(supervisor, port: str) -> None:
    process = supervisor(TRADE_JOURNAL_PORT=port)
    output, error = process.communicate(timeout=5)
    assert process.returncode == 1
    assert output == ""
    assert "TRADE_JOURNAL_PORT" in error
