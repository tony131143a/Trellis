"""
The node driver behind ``scripts/arbor.py``:

    repos     a task, its task.json and the repositories it works in
    plan      the task's nodes/ directory read into task.json
    sync      one step of the event loop: start, settle, merge and gate nodes
    finish    review records, finish, cleanup and archive
    orca      starting a node as an Orca worker and reading its state back
    executor  the executor configuration (agents, tiers, limits)
    prompt    the whole prompt of a worker
    gate      level-0 verification: project gate commands + contract auto checks
    lock      the per-task lock around task.json edits

The driver owns control flow; models write the contract and the node files
and make the judgement calls the driver reports back.
"""
