Fix round 1 for orch-workflow-assets (same scope and rules as before; engine .py files are still read-only for you and are being edited by others — their command surface and decision options do not change).

Findings (in /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-as-fidelity.json and r1-as-contract.json):
- r1-as-fidelity-2 + r1-as-contract-1/-2 (confirmed): briefs/finder.md:13 and verify.md:12 must name the cards `review-finder` / `review-verify`. Grep all assets for any other `check` / `check-verify` card reference.
- r1-as-fidelity-1 (confirmed): make the 2.2 decision playbook match the engine exactly — derive the option list of every decision kind from the `_set_decision(...)` calls in pipeline.py / integration.py and list per kind only allowed options (gates: fix / accept / escalate; validate_fail keeps retry). Keep conductor.md consistent with the same table.
- r1-as-fidelity-3 (confirmed): 2.3 Rollback must only prescribe paths the engine accepts (check orch.py stage guards for plan / scan / abort and what a fresh start after abort requires). If no in-place re-plan exists, say so and give the working route.
- r1-as-contract-3 (confirmed): the block test must use the injector's pair regex (`inject-workflow-state.py` `_TAG_RE`, open/close with backreference) so a mismatched closing tag fails.
- r1-as-contract-4 (confirmed): scope the Phase 2 assertions to the Phase 2 section text.
- r1-as-fidelity-4: accepted, no change — the 3.4 reply tokens are copied verbatim from native and stay identical to native.
Re-run your validation. Report ≤12 lines.
