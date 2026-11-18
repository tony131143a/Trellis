"""
Terminal output utilities: ANSI colors.

Single source of truth for Colors used across all Arbor scripts.
"""

from __future__ import annotations


class Colors:
    """ANSI color codes for terminal output."""

    YELLOW = "\033[1;33m"
    NC = "\033[0m"  # No Color / Reset


def colored(text: str, color: str) -> str:
    """Apply ANSI color to text."""
    return f"{color}{text}{Colors.NC}"
