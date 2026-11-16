---
sources: []
last_verified: 2026-11-13
---
# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

Most bugs happen at layer boundaries: one side returns format A and the other expects B, a transform loses data, or several layers implement the same logic differently.

## Before Implementing

- Map the flow (source, transform, store, retrieve, transform, display). For each arrow: what format is the data in, what could go wrong, who validates?
- For each boundary (API/service, service/database, backend/frontend, component/component): what is the exact input format, the exact output format, and which errors can occur?
- Are format assumptions (dates, nulls) implicit? Convert explicitly at the boundary.
- Is the same thing validated in several layers? Validate once, at the entry point.
- Does a layer know more than its neighbors (a component that knows the database schema)?
- Do several consumers parse the same payload (an append-only log, JSON stream, RPC payload, config file)? Give it one owner for the type definitions, the guards and normalization from `unknown`, the projections UI commands use, and the reducers that replay state. Rendering code may format fields but must not redefine the payload contract.

## Checklist

Before implementation:

- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined the format at each boundary
- [ ] Decided where validation happens

After implementation:

- [ ] Tested edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives a round-trip
- [ ] Consumers import shared decoders / projections instead of casting payload fields locally
- [ ] Derived state points back to the source event identifier (`seq`, `id`, `version`) instead of inventing a second position marker

## Runtime-Parsed Templates

Some generated files are also runtime input: `.arbor/config.yaml` is installed from `templates/arbor/config.yaml` and parsed by `common/config.py` and `common/arbor_config.py`. After changing such a template:

- [ ] Identified every runtime parser that reads it, not just the writer that installs it
- [ ] Checked for relevant syntax outside the obvious managed regions (tag blocks)
- [ ] Verified fresh `init` output and an `update` from an older `.arbor/.version`
- [ ] Added an upgrade regression from an older pristine template that asserts the installed file reaches the current shape
- [ ] Updated the backend spec that owns the runtime contract
