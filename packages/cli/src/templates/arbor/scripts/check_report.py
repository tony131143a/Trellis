#!/usr/bin/env python3
"""Check a review report from stdin without changing task state or files.

Usage: python3 -B .arbor/scripts/check_report.py < report.txt
Exit 0: valid report; exit 1: correct the report before returning it.
This checks format and consistency only, not the correctness of the review.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict

# Keep this command read-only even when the caller omits -B.
sys.dont_write_bytecode = True

from common.driver.validate import check_reply


def main() -> int:
    result = check_reply("review", sys.stdin.read())
    # The driver safely downgrades contradictory PASS + findings to FAIL.
    # Preflight asks the author to make that verdict explicit instead.
    valid = result.ok and result.problem is None
    print(json.dumps({**asdict(result), "ok": valid}, ensure_ascii=False))
    return 0 if valid else 1


if __name__ == "__main__":
    sys.exit(main())
