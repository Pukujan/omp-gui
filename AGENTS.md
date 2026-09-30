# Agent Operating Contract (omp-gui)

GitHub Issues own task scope, acceptance, ownership, dependencies, lifecycle, and durable progression. Merged default-branch history owns accepted code. PR checks and merge records own delivery facts. The files in `PROJECT.md`, `checkpoints/CURRENT.md`, and `tasks/` are mandatory versioned projections of that state, not a parallel authority.

## Progression rules (PCM, single-user)

- PR-only to `main`. Required status check: `test`. Branch protection + auto-merge (squash) are enabled; green checks merge without a human click. Reviews are not required (single user).
- One primary writer per task branch (`task/OG-<issue>-<slug>`). Never force-push or overwrite another writer's work.
- Before each push: synchronize docs/projections, then `continuity checkpoint` (stable REQUEST_ID, synchronous push). After each successful push: publish a leaf-issue receipt keyed by REQUEST_ID + exact SHA; link the parent (#1) progression update.
- After CI/merge: append check results, PR/merge SHA, and live issue status to the leaf; fetch and verify accepted history before closing. Missing/failed/skipped/stale gates fail closed — no completion claim.
- Issue closing keywords per GitHub rules (`Closes #N` only when the merge completes the issue; `Refs #N` for progress-only).
- Label observed facts vs *inferred*; never commit secrets; `.env` stays local.

## Working-repo scope

Code, branches, PRs, and boss actions only in `Pukujan/omp-gui`. Foreign repos: proposal-style issues only.

## Start

Read PROJECT → CURRENT → active TASK → the live owning issue (`continuity issue verify <TASK-ID>`) before editing.
