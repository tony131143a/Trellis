"""
A portable per-task lock: parallel ``arbor run --partition`` processes share
one ``task.json`` and one task branch.

The lock is the directory ``<task>/.lock`` (``os.mkdir`` is atomic on every
platform) holding the owner's pid. A waiter retries for ``TIMEOUT_S``; a lock
whose owner pid is dead is taken over. Inside one process the lock is
re-entrant. The directory carries a ``.gitignore`` of ``*`` so git never
sees it.

Hold it around every read-modify-write of task.json, dispatch-id
allocation and the task-dir commit; never around an executor run.
"""

from __future__ import annotations

import os
import shutil
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

LOCK_DIR = ".lock"
TIMEOUT_S = 30.0
POLL_S = 0.05
# A lock dir without a pid file is a writer between mkdir and write; give it this long.
NO_PID_GRACE_S = 5.0

_held: dict[Path, int] = {}


class LockTimeout(RuntimeError):
    pass


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _owner(lock: Path) -> int | None:
    try:
        return int((lock / "pid").read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _stale(lock: Path) -> bool:
    pid = _owner(lock)
    if pid is not None:
        return not pid_alive(pid)
    try:
        return time.time() - lock.stat().st_mtime > NO_PID_GRACE_S
    except OSError:
        return False


def _take_over(lock: Path) -> None:
    """Move a stale lock aside (rename is atomic: one taker wins) and drop it."""
    aside = lock.with_name(f"{LOCK_DIR}.stale-{uuid.uuid4().hex[:8]}")
    try:
        os.rename(lock, aside)
    except OSError:
        return
    shutil.rmtree(aside, ignore_errors=True)


def acquire(task_dir: Path, timeout: float = TIMEOUT_S) -> None:
    lock = task_dir / LOCK_DIR
    key = lock.resolve()
    if _held.get(key):
        _held[key] += 1
        return
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.mkdir(lock)
        except FileExistsError:
            if _stale(lock):
                _take_over(lock)
                continue
            if time.monotonic() >= deadline:
                raise LockTimeout(f"{lock} is held by pid {_owner(lock) or '?'} (waited {timeout:g}s)")
            time.sleep(POLL_S)
            continue
        (lock / ".gitignore").write_text("*\n", encoding="utf-8")
        (lock / "pid").write_text(str(os.getpid()), encoding="utf-8")
        _held[key] = 1
        return


def release(task_dir: Path) -> None:
    lock = task_dir / LOCK_DIR
    key = lock.resolve()
    count = _held.get(key, 0)
    if count > 1:
        _held[key] = count - 1
        return
    _held.pop(key, None)
    if _owner(lock) == os.getpid():
        shutil.rmtree(lock, ignore_errors=True)


@contextmanager
def task_lock(task_dir: Path, timeout: float = TIMEOUT_S) -> Iterator[None]:
    acquire(task_dir, timeout)
    try:
        yield
    finally:
        release(task_dir)
