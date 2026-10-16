---
description: "Decisions for sub-squad issue-4"
---

# Decisions: issue-4

### 2026-10-16T08:11:24Z Root cause and fix for recurring CartController OOM (Peter-N91/grubify#4)

* Turn: 1
* Request: Watch Mode autopilot run for incident Peter-N91/grubify#4
* Outcome: Acceptance = fix proposed, not deployed. Root cause confirmed in GrubifyApi/Controllers/CartController.cs: a static List<byte[]> RequestDataCache appended a 10MB buffer on every AddItemToCart call with no eviction, matching the incident evidence and the prior Peter-N91/grubify#2 incident whose permanent fix was never deployed.
* Fix applied: removed the unbounded RequestDataCache field and its per-request 10MB allocation/append/logging from AddItemToCart. No other behavior changed.
* Validation performed: static code review only (view/grep of CartController.cs). No dotnet build/test executed this turn due to the native session credit cap.
* Limitations: no live Azure access used; no cloud/network integration tests run; no load test reproduced the OOM.
* Dispatched roles/history: see history/autopilot-run-38871296173.md (orchestration) and history/developer.md (code change). tester role not reached.
* Remaining human prerequisites: run dotnet build/test for GrubifyApi, confirm no other RequestDataCache callers, deploy via normal release pipeline, confirm the Container Apps revision no longer OOMs under the same traffic profile.
* Impactful-Action Gate: not crossed. No push/commit/merge/deploy/workflow-dispatch/issue-write/infrastructure action performed. Source left uncommitted; a separate deterministic job creates the branch and draft PR.

## Blocking findings

* tester role (Squad Reviewer) not dispatched: native 90-AI-credit soft cap reached before test execution. No test-pass evidence exists; must be verified by a human or follow-up run before merge.
* dotnet build/test not run; compilation unverified beyond manual review.
