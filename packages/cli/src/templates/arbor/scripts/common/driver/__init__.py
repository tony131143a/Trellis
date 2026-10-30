"""
The arbor v2 driver (``scripts/arbor.py``) and its three concerns:

    state     the state table, counters and progress rules (``next``)
    executor  running one dispatch through the configured executor command
    validate  fail-closed reply checks, finding ids, the mechanical prefilter
    gate      level-0 verification: project gate commands + contract auto checks

The driver owns control flow; models only write briefs and make the
judgement calls the state table asks for (``needs: decide`` / ``human``).
"""
