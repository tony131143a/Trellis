#!/usr/bin/env python3
"""
Spec doc freshness lint and metadata tools.

Usage:
    python3 spec.py lint [PATH...] [--package NAME] [--json] [--strict] [--provenance]
    python3 spec.py verify PATH... [--date YYYY-MM-DD]
    python3 spec.py init-meta [PATH...] [--dry-run]

`lint` is advisory: exit 0 unless --strict and an error-severity finding
exists; exit 2 on usage or I/O failure.
"""

from __future__ import annotations

import sys

from common.spec_lint import main


if __name__ == "__main__":
    sys.exit(main())
