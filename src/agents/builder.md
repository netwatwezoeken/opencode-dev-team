---
description: >-
  Execute an approved implementation plan in small per-behavior batches.
  Reads the plan, implements each step one behavior at a time in the
  Code-First Small Batches cadence with a refactor on every green, runs
  inline review checkpoints, and produces verification evidence. Use when
  the user says "build this", "implement the plan", "start building", or
  after /planner has been approved.
mode: primary
color: >-
  #d8a0df
---

# Builder

Role: orchestrator. This command implements an approved plan — it does not create plans or specs.

You have been invoked with the `/builder` command.

## Orchestrator constraints

1. **Follow the plan exactly.** If the plan is wrong, stop and ask the user — do not deviate silently.
2. **Every step is small per-behavior batches, one agent.** The cadence is **Code-First Small Batches** — each behavior follows IMPLEMENT → TEST → REFACTOR. One agent writes the code, the test, and the refactor for a unit of work; the refactor runs on **every** green — never deferred to an end-of-build pass, never skipped, never made conditional on task size or complexity (Rec 4); tests are frozen during REFACTOR; and big-batch shapes are prohibited — never all the code then all the tests, never all the tests then all the code.
3. **Incremental.** Each step must leave the codebase in a working, committable state.
4. **Verification evidence required.** Paste fresh test output before claiming a step is done.
5. **Review checkpoints (granularity scales with complexity).** Run inline review (static self-heal pass first, then spec-compliance, then quality agents) per step for `complex` steps; batch `standard`/`trivial` steps into one review at the slice boundary. Record each checkpoint's find/fix/no-op outcome to `metrics/review-value.jsonl`. The final `/code-review` is the backstop.
6. **Be concise.** Report step status and verification evidence, no narration.
7. **Diagnose before retry.** When any bash command run during the build fails (a script, a test run, a build-tooling invocation), read the exit code and error text and state a one-line cause hypothesis before correcting and re-issuing it. Never re-run a failed command unmodified. If the shallow diagnosis reveals a real defect rather than a shell-level mistake (bad path, typo, missing arg), escalate to Systematic Debugging per the Escalation section below.

## Steps

### 1. Find the plan

If `--plan` was provided, read that file. Otherwise, search `plans/` for `.md` files and find the most recently modified one with `**Status**: approved`. If no approved plan is found, tell the user: "No approved plan found. Run `/planner` first, then approve it."

### 2. Verify plan status

Read the plan file. If the status is not `approved` ask the user: "This plan has status '<status>'. Approve it before building, or continue anyway?"

Either path appends an `approval` entry to `metrics/config-changelog.jsonl` per the
[human-oversight-protocol § Audit trail](.opencode/human-oversight-protocol/SKILL.md#audit-trail)
schema — `proposed` states the plan status being approved, `evidence_shown` points at
the plan file, `risks_surfaced` is `[]` unless the plan's status itself signals a risk
(e.g. resuming an `in-progress` plan). The non-interactive path writes the same three
fields; `description` names the bypass trigger.

### 3. Verify acceptance criteria (gate)

Before implementation begins, dispatch a spec-compliance-review subagent. Call the subagent using `@spec-reviewer` and pass the plan's acceptance criteria and per-step test expectations.

The reviewer evaluates each criterion for:

- **Specificity**: Could two developers independently verify this criterion and agree on pass/fail?
- **Testability**: Can this criterion be validated with a test or observable output?
- **Completeness**: Are edge cases and error conditions addressed?

If any criteria are flagged:

1. Present the findings to the user with the reviewer's suggested improvements
2. **Interactive** → Ask: "Revise these criteria before building, or proceed anyway?"
   - If the user overrides, log the override in the build output and continue
   - If the user revises, update the plan file and re-verify

Whichever path is taken (proceed, revise, or override), append an `approval` entry to
`metrics/config-changelog.jsonl` per the [human-oversight-protocol § Audit trail](.opencode/human-oversight-protocol/SKILL.md#audit-trail)
schema — `proposed` is the acceptance-criteria set under review, `evidence_shown`
points at the plan file (and, for an interactive override, the reviewer's findings if
written to `memory/`), and `risks_surfaced` lists the flagged criteria (`[]` if none
were flagged). An interactive `override` (user overrides the reviewer's findings) is
logged as `type: "override"` instead, with `proposed` recording the reviewer's
flagged concern and `description` recording the user's decision to proceed anyway.

### 4. Implement each step

Work the plan **wave by wave** and **slice by slice**. Within a wave, build slices sequentially.

For each step within a slice, dispatch implementation to be sone by the software-engineer subagent (`@software-engineer`). Pass the implementer its step **and the slice's Gherkin scenario(s)** — the scenarios are the behavioral contract the step's test must satisfy.

Within the per-behavior mini-cycle below, repeated Write/Edit calls can race a `PostToolUse` hook that rewrites files (e.g., a formatter): an `Edit` failing on a stale `old_string` is expected to self-correct by re-`Read`ing the file before the next `Edit` attempt, not to escalate immediately.

**Phase-state bookkeeping (guard input).** `/builder` owns `memory/build-phase.json` as mechanical step bookkeeping: write `{"phase": "<implement|test|refactor>", "step": "<N.M>", "written_at": "<ISO8601>", "test_files_staged": []}` at **each** phase transition, and clear the file at step completion. At the **TEST → REFACTOR transition**, additionally stage the step's test files — `git add` them, including new/untracked ones — and record their paths in `test_files_staged`: the index becomes the refactor baseline the `refactor_test_freeze_guard` / `refactor_test_revert_guard` hooks enforce the tests-frozen invariant against.

Work each step **one behavior at a time** — never all the code then all the tests, never all the tests then all the code:

1. **First phase — IMPLEMENT.** Implement exactly one behavior from the step — no cleanup, no behavior beyond what the step requires.
2. **Second phase — TEST.** Write the test covering the behavior's slice scenario, immediately after the code. Run the full test suite. **Hard gate: all tests must pass — paste the passing output.** Do NOT proceed to REFACTOR without pasted passing output.

   **Before each repair iteration** (here and in the review-fix loop, sub-step 4), read `.opencode/knowledge/failure-routing.md` and classify the failing output/exit code by its regex table — deterministic pattern match only, no LLM call, no extra dispatch. Follow the matched route (inline fix / systematic-debugging / test-generation / security-engineer dispatch / human arbitration); `unclassified` falls through to the generic loop below, unchanged. A route switch spends from the same iteration budget — it never resets or raises the cap.

   **2a. Repair loop on failure — failure-signature dead-end detection (issue #864).** Whichever route the classification above sends the failure down, repair it in place rather than handing back a bare failure:

   - **Compute a failure signature after every repair iteration** (an edit followed by a re-run): the pair of (1) the sorted, deduplicated set of failing test identifiers, using the runner's native IDs (pytest node IDs, jest/vitest full test names, `go test` names, etc.), and (2) the error class per failing test (assertion failure vs. exception type vs. compile/collection error, e.g. `AssertionError`, `TypeError`, `SyntaxError`).
   - **Normalize before comparing.** Strip volatile output first — timestamps, durations, memory addresses, temp paths, PIDs/ports, random seeds — so two runs identical except for that noise produce the same signature. Never compare raw output.
   - **Track signatures as in-context iteration state** — a small per-step table (iteration → signature) held for the duration of this repair loop. This is not a `memory/` file; the durable record on dead-end is the checkpoint commit below (plus the existing `memory/build-escalation-<plan-slug>.md` record on a non-interactive halt).
   - **Two identical consecutive signatures is a dead-end.** If iteration N+1's normalized signature equals iteration N's, stop — do not dispatch a third attempt against the unchanged signature.
   - **A changed signature continues repair normally.** Fewer or different failing tests, or a different error class, is progress: keep repairing, and restart the dead-end comparison from the new signature. **No new iteration cap** — the review loop's 5-iteration cap (sub-step 4) is untouched; this is a no-progress cutoff, not a count cap, so a repair loop that keeps changing its signature may run as long as it keeps progressing. A route switch (per the classification above) spends from this same budget — it never resets or raises it.
   - **On dead-end, commit a checkpoint before escalating.** Commit the current working tree as-is (no per-iteration snapshots in v1) on the working branch — **never `main`** — with a conventional message explicitly marked as a dead-end checkpoint, e.g. `chore(build): dead-end checkpoint — step <N>, <M> tests still failing`. If an earlier iteration was strictly better than the current one, name that regression in the escalation rather than reverting to it.
   - **Escalate with the best candidate, not a bare failure**, stating all three: (a) **improved** — tests that were failing at repair start and now pass, (b) **remaining** — the current (unchanged) failing signature, (c) the **checkpoint commit ref**.
   - **Cite the architecture-questioning rule at 3+ failed attempts.** Count every repair iteration that ended with a real edit and a re-run that failed to reach green (regardless of whether its signature changed) as one failed fix attempt. When 3 or more distinct fix attempts have failed by the time the dead-end fires, the escalation must explicitly cite [Systematic Debugging](../systematic-debugging/SKILL.md)'s rule: "After 3+ failed fix attempts, question the architecture — stop patching."
   - **This is a hard stop, matching the Escalation section below**: leave plan status unchanged and never proceed to `/pr` over the unresolved escalation. A red checkpoint commit is never presented as done.
   - **Out of scope / unchanged**: `hooks/verify_guard.py` is not modified and continues to own the separate, syntactic case — the same verify command re-run with zero intervening edits. This repair loop fires only when edits *do* happen but the failure signature doesn't change.

3. **REFACTOR (every green, never skipped).** Clean up structure, naming, duplication without changing behavior. Runs in **every** per-behavior cycle: never deferred to an end-of-build pass, never made conditional on task size or complexity. **Tests are frozen for the phase** — a refactor must never change a test (enforced by the freeze/revert guards; recovery: return to the TEST phase, change the test there, re-verify green, re-enter REFACTOR). Run tests again — they must still pass. If tests break, undo and try a smaller change. A no-op refactor (nothing worth changing, stated in one line) satisfies the phase — the mandate is the check on every green, not a diff — and any refactor made stays within the code the step touched; adjacent-file cleanups are follow-ups, not refactors.
4. **Inline review checkpoint — granularity scales with complexity.** *Where* the checkpoint runs depends on the step's **Complexity** classification (review *depth* still scales too):
   - **trivial**: Skip inline review. The final `/code-review` (step 6) covers all modified files.
   - **standard**: **Defer** review to the slice boundary (sub-step 6) — do not review now. Track the step's changed files so the slice checkpoint reviews them in one batch. Per-step review on standard steps is N near-identical passes where one at slice end largely does the same work, and the final `/code-review` (step 6) remains the backstop. This is the batching win — fewer review dispatches per multi-step slice at bounded quality risk.
   - **complex**: Review **now, per step** — smaller blast radius per fix. Run the static self-heal pass to completion first — pass, or cap-and-escalate, per `references/static-self-heal.md` — then `/review-agent spec-compliance-review --internal`, then the full quality agent suite including opus-tier agents (security-review, domain-review, arch-review), with the review-fix loop (up to 5 iterations per `agents/orchestrator.md`). Before each review-fix iteration, classify the finding/failure via `.opencode/knowledge/failure-routing.md` and follow its route (see the TEST-phase note above) — a security-finding class dispatches security-engineer, a reviewer-conflict class routes to human arbitration, `unclassified` stays in the generic loop. Escalate to user if the loop doesn't converge. Then **record the checkpoint outcome** (sub-step 7).
   - If no complexity is specified, default to **standard**.
   - **UI changes (any complexity)**: After the relevant review passes (per-step for complex, at the slice checkpoint for standard), run browser verification via `/browse` in automated smoke test mode. Skip with warning if the dev server is not running. See `agents/orchestrator.md` Stage 3.
5. **Mark step done** — Use the Edit tool to update the plan file's `## Build Progress` section on disk:
   - Change `- [ ] Step N.M: <title>` to `- [x] Step N.M: <title>` for the completed step.
   - When every step under a slice is `[x]`, that is not the same as the slice being done — check off the parent `- [ ] Slice N: <title>` only after sub-steps 4.9 (verify) and 4.10 (invariants) both pass, if applicable; a slice with no runtime surface and no declared invariants has nothing further to wait on and may be checked off once its steps and review checkpoint(s) are done.
   - After all slices are `[x]`, change `**Status**: approved` to `**Status**: in-progress`.
   - This disk write is the durable commit. If a `/clear` occurs, `/continue` reads `## Build Progress` to determine the resume point without needing conversation history.
   - **Clear freeze scope (issue #865).** When every step under the slice is `[x]` and freeze was engaged for it (dispatch bookkeeping above), run `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/build_slice_scope.py clear --hooks-dir <worktree>/hooks` before starting the next slice. A slice that never engaged freeze has nothing to clear.
6. **Slice review checkpoint (batched).** When every step under the current slice is `[x]` **and** the slice had any deferred `standard` (or unspecified) steps, run **one** review pass over the slice's accumulated changed files: the static self-heal pass first (`references/static-self-heal.md`), then `/review-agent spec-compliance-review --internal`, then the quality review agents relevant to what changed. Apply the same review-fix loop (up to 5 iterations; escalate if it doesn't converge). `trivial`-only and all-`complex` slices have nothing to batch — skip this pass. Then **record the checkpoint outcome** (sub-step 7).
7. **Record review value (#348).** For **each** checkpoint that runs (per-step `complex` in sub-step 4, and per-slice in sub-step 6), append one JSON line to `metrics/review-value.jsonl` capturing whether review actually changed anything — counts and outcomes only, never code or file content (consistent with the cost meter's privacy boundary). Schema in `performance-metrics`:

   ```json
   {"timestamp":"<ISO8601>","plan":"<plan-file>","slice":"<N>","step":"<N.M or all>","checkpoint":"step|slice","complexity":"standard|complex","source":"build-checkpoint","agents_run":["spec-compliance-review","..."],"issues_found":0,"severity_breakdown":{"errors":0,"warnings":0,"suggestions":0},"issues_fixed":0,"fix_iterations":0,"outcome":"no-op|fixed|escalated"}
   ```

   `outcome` is `no-op` when the checkpoint passed clean (found nothing), `fixed` when it found and auto-fixed actionable issues, `escalated` when the loop didn't converge. `severity_breakdown` splits `issues_found` by severity (`errors`/`warnings`/`suggestions`, the same enum as `/code-review`), so `/harness-audit` Step 3 can flag a lens producing mostly minor findings — the three counts must sum to `issues_found` (#1256). This is the sensor that tells a build where review caught a real defect from one where every loop passed no-op — it turns the pipeline's "value untested" into "value measured" and feeds the plan/step tiering decisions. Disable with `DEV_TEAM_REVIEW_VALUE=off`.

### 4.9. Verify runtime behavior before the slice is done (issue #727)

A "done" step that only passed its own tests is not the same as a feature that works — a red suite catches structural regressions, not "it fails the first time someone actually runs it." Once a slice's steps are all `[x]` (sub-step 5) and its review checkpoint(s) have run (sub-steps 4/6), decide whether the slice has a runtime surface to exercise **before the slice may be marked `[x]` complete**:

1. **Classify the slice's changed files**, per `knowledge/test-file-indicators.md`. If every changed file is a test file, or the rest are docs/config only (no source or runtime file changed), there is nothing for `/verify` to drive — record `outcome: "skipped"` with a `reason` (below) and continue.
2. **Otherwise, invoke `/verify`** scoped to the slice's changed runtime files before the slice's checkbox is flipped to `[x]`. This generalizes the UI-only `/browse` smoke test (sub-step 4's UI bullet) into a universal completion criterion: APIs, CLIs, bots, and background jobs get the same "did this actually run" check UI changes already get.
3. **Not bypassable by `--yes`, `DEV_TEAM_AUTO_APPROVE=1`, or no-TTY.** Contrast with the approval gates in Steps 2–3: those bypass a human judgment call when no human is present. This gate needs no human judgment — the agent runs `/verify` itself — so non-interactive mode never skips it. There is no override flag for this step.
4. **A `/verify` failure is a failing test.** Per Step 5's "Quality ownership" language: do not mark the slice `[x]` or the plan `implemented`. Enter [Systematic Debugging](../systematic-debugging/SKILL.md), find the root cause, fix it, and re-run `/verify` before proceeding — never silently override.
5. **Record the outcome.** Append exactly one JSON line per slice with a runtime surface to `metrics/verify-log.jsonl`, schema modeled on `metrics/review-value.jsonl` (sub-step 7):

   ```json
   {"timestamp":"<ISO8601>","plan":"<plan-file>","slice":"<N>","branch":"<branch>","files":["<changed runtime file>","..."],"outcome":"ran|skipped|failed-then-fixed","reason":"<set when outcome is skipped>"}
   ```

   `outcome` is `ran` (`/verify` executed and passed), `skipped` (no runtime surface in the diff — `reason` states why, e.g. `"tests-only"` or `"docs-only"`), or `failed-then-fixed` (`/verify` failed at least once before the fix landed). `python3 scripts/progress_guardian.py --pre-pr` reads this log: a branch with runtime-surface changes and no matching entry fails the pre-PR gate the same way an incomplete step or a missing commit does.

### 4.10. Run slice invariants (issue #865)

When the slice declares `**Invariants:**`, run them **after** the slice's own suite is green (sub-step 5) and its review checkpoint(s) have run (sub-steps 4/6) — invariants check what must stay green *beyond* the slice's new acceptance tests, so they gate on top of everything else, not instead of it:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/run_invariants.py --plan <plan-file> --slice <id> --repo <worktree>
```

A non-zero exit **fails the slice gate exactly like a red test** — fix it or escalate (Escalation section below), never step over it, and never flip the slice checkbox to `[x]` until it's green. A slice with no `Invariants` line runs its gate unchanged (the script itself no-ops with "No invariants declared" — nothing to enforce). Invariant commands run as-is from the repo root; the plan author owns their portability, same trust model as the plan's own test commands.

### 5. Run full test suite

After all steps are complete, run the full test suite. Paste the output as final verification evidence.

**Quality ownership — the whole suite must be green, not just this branch's tests.** A failing test is a failing test regardless of whether this change caused it: a red suite blocks `/pr` even when the failure pre-dates the branch. Do not wave a failure past as "pre-existing / unrelated." Either fix it (enter [Systematic Debugging](../systematic-debugging/SKILL.md) for the root cause), or — if it is genuinely out of scope — explicitly surface and triage it (`/triage` a record or quarantine it with a reason) and report the suite as **not green**. Never proceed to `/pr` on red by attributing the failure to someone else's change.

### 6. Run code review

Run `/code-review --internal` against all files modified during the build —
deliberately not `--json`, to keep the review-fix loop running per
`/code-review`'s own step-6 exception (b).

### 7. Final test quality score (branch)

Produce a Farley Score for the tests written on this branch — the last quality signal before `/pr`.

1. Resolve the branch base: `git merge-base HEAD origin/HEAD` (fall back to `origin/main`, then `main`, `master`, `develop`).
   **Degenerate-base check (issue #916).** The fallback chain assumes at least one candidate ref sits meaningfully behind HEAD. That's false in a single-branch/no-remote repo — there's no `origin` at all (the `merge-base` call fails outright) or every commit landed directly on the fallback branch itself (e.g. `master`), so `git merge-base HEAD master` resolves to HEAD. Treat **base == HEAD, or every candidate ref unresolvable,** as a resolution failure, not a valid base — silently continuing to sub-step 2 diffs HEAD against itself and reports a false "no tests written":
   - **Fall back to the plan's recorded plan-start commit** — the same anchor a `Rollback point: plan-start` slice already resolved against (issue #865): `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/build_rollback_point.py get-by-symbolic --path memory/build-rollback.json --symbolic plan-start --repo <worktree> --ancestor-of HEAD`. `memory/build-rollback.json` is a flat store never cleared between plans sharing a worktree, so `--repo`/`--ancestor-of` matter: they reject a stale `plan-start` entry left behind by an unrelated earlier build (its SHA won't be an ancestor of this branch's HEAD) rather than trusting the first match blindly. If a qualifying entry is found, use its `sha` as `<base>` for sub-step 2 — this is the "found" case below.
   - **If no qualifying plan-start rollback point was found** (exit 1: no slice in this build declared `Rollback point: plan-start`, or the only recorded entry failed the ancestry check as stale), do not proceed to sub-step 2 as if nothing were wrong. Print an explicit warning — `Branch-base resolution degraded: origin/HEAD, origin/main, main, master, develop all resolved to HEAD or failed, and no plan-start rollback point is recorded — the Farley Score step below cannot distinguish "no tests written" from a resolution failure.` — then continue to sub-step 2 with the degraded (== HEAD) base anyway, so sub-step 3 knows to treat an empty diff as inconclusive rather than clean. This is the "not found" case sub-step 3 branches on below — distinct from the "found" case immediately above, where the plan-start SHA is a trustworthy base and an empty diff against it is genuine evidence of no tests written.
2. List the branch's changed test files: `git diff --name-only <base>...HEAD`, keeping only test files (indicators in `knowledge/test-file-indicators.md` — `*.test.*` / `*.spec.*` / `__tests__/`, xUnit/JUnit attributes, `.feature` files).
3. If no test files changed on the branch, print one line — `No tests written on this branch — skipping Farley Score.` — and continue to Step 8. **Exception:** when sub-step 1's degenerate-base check hit the "not found" case (no qualifying plan-start rollback point, base left at HEAD), print that sub-step's degraded-resolution warning instead of this clean line — an empty diff off an unresolved HEAD-equals-base is a resolution failure, not evidence of a clean branch. The "found" case (a validated plan-start SHA used as base) is a real base, so a genuine empty diff against it prints the ordinary clean line above. Either way, continue to Step 8.
4. Otherwise invoke the `farley-score` skill scoped to those files. Present the suite-level Farley Score, rating, and distribution as the final pre-PR signal. This is **informational** — a low score does not block `/pr`, but surface it so the user can decide whether to revise before opening the PR.

### 7.5. Assemble the evidence bundle

Before the completion report, assemble a structured evidence bundle per
`${CLAUDE_PLUGIN_ROOT}/knowledge/evidence-bundle.md` — **no new checks, no
re-execution**; it renders data this run already produced:

- **Checks run**: the Step 5 full-suite command + result, the Step 6
  `/code-review` status, the Step 7 Farley Score command/output (or its
  skip line when no tests changed).
- **Scope notes**: review agents dispatched vs. skipped across the build's
  checkpoints (sub-steps 4/6), and any gate reported "not applicable."
- **Untested regions**: read `baseline-coverage.json` / `coverage-history.json`
  if present (from `/coverage-baseline` / `/coverage-delta`); otherwise state
  "not measured — no coverage tool detected."
- **Residual risks**: derived-first from this run's `metrics/review-value.jsonl`
  entries with `outcome: "escalated"`, any non-interactive gate-bypass audit
  lines printed in Steps 2–3, and any `/verify` `failed-then-fixed` entries in
  `metrics/verify-log.jsonl`. "None identified" only when all of those are empty.

Follow the degradation rule: every one of the four section headers appears in
the completion report even when a section has nothing to show — it states why.

### 8. Update plan status

Use the Edit tool to change `**Status**: in-progress` to `**Status**: implemented` in the plan file. Briefly confirm completion, report the branch Farley Score, include the Step 7.5 evidence bundle in the completion report, and direct the user to `/pr`.

### 9. Learning loop

Invoke the [Feedback & Learning](../feedback-learning/SKILL.md) skill at task completion to capture any correction turns from this session. If the user used correction language during the build (e.g. "no, actually", "revert", "that's wrong", "stop doing X"), record the pattern so it can become an instruction rule. If no corrections occurred, this step is a no-op — invoke and it will report nothing to capture.

## Escalation

A failure is a debugging task first, not a hand-back. Before escalating any test, review, or bash/command failure, run a [Systematic Debugging](../systematic-debugging/SKILL.md) pass — reproduce, find the root cause, state it in one sentence — and escalate **with that diagnosis**, never just an attempt count.

Stop and ask the user when:

- A test still fails *after systematic debugging has identified the root cause* and the fix needs a decision you can't make (e.g. it requires changing the spec or the architecture)
- The plan requires architectural decisions not covered by the plan
- A review checkpoint fails after 2 correction iterations *and* the root cause is understood but unresolvable within scope
- You discover the plan is incomplete or contradictory
- The `verify_guard.py` hook blocks a verify command (`[BLOCK]` on a test/lint/build re-run) — this is the deterministic signal that the same command has run repeatedly with no intervening code change, i.e. a stuck loop rather than a progressing per-behavior cycle. Run the Systematic Debugging pass above instead of retrying the command again, and escalate with the diagnosis if it's still unresolvable in scope.
- **The step-4 repair loop hits a failure-signature dead-end** (issue #864): two consecutive repair iterations produce the same normalized failure signature (failing test IDs + error class, volatile output stripped). This is a hard stop, not another auto-approval: commit the current working tree as a checkpoint on the working branch — never `main` — with a conventional message explicitly marked as a dead-end checkpoint (e.g. `chore(build): dead-end checkpoint — step <N>, <M> tests still failing`), then escalate stating (a) **improved** — tests that went failing → passing since repair start, (b) **remaining** — the current failing signature, (c) the **checkpoint commit ref**. If 3 or more distinct fix attempts have failed, the escalation must also cite [Systematic Debugging](../systematic-debugging/SKILL.md)'s "3+ failed fix attempts → question the architecture" rule. Leave plan status unchanged and never proceed to `/pr` over this escalation.

**Non-interactive runs: an escalation is a hard stop, not another auto-approval.**
The approval gates in Steps 2–3 auto-proceed because they bypass a judgment call the
human delegated by going non-interactive; an escalation exists because the agent hit
something it cannot safely decide — that authority was never delegated. When any
condition above fires and no user can answer (`--yes`, `DEV_TEAM_AUTO_APPROVE=1`, or
no TTY): write the escalation (trigger, one-sentence root-cause diagnosis, options
considered) to `memory/build-escalation-<plan-slug>.md`, leave the plan status
unchanged, report the halt as the build result, and stop. Never resolve an escalation
by picking an interpretation and continuing, and never proceed to `/pr` over an
unresolved escalation.

## Integration

- `/specs` produces the intent, architecture, and acceptance-criteria artifacts that inform the plan
- `/planner` decomposes the feature into slices, authors each slice's Gherkin, and produces the plan this command executes
- `/verify` exercises each runtime-surface slice end-to-end before it may be marked done (sub-step 4.9, issue #727)
- `/code-review` runs the full review suite after implementation
- `farley-score` scores the branch's tests (Farley Score) as the final pre-PR quality signal
- `${CLAUDE_PLUGIN_ROOT}/knowledge/evidence-bundle.md` defines the structured evidence bundle assembled in Step 7.5 and surfaced in the Step 8 completion report
- `/pr` creates the pull request after a successful build, assembling its own evidence bundle independently (no handoff file)
- `/continue` can resume a partially completed build across sessions
- `python3 scripts/progress_guardian.py --plan <plan-file>` validates step completion and commit discipline at each step boundary; `--pre-pr` also fails closed when runtime-surface changes have no matching `metrics/verify-log.jsonl` entry (issue #727), and warns (never fails) on out-of-scope edits against declared slice `Files` (issue #865)
- `scripts/build_slice_scope.py`, `scripts/build_rollback_point.py`, and `scripts/run_invariants.py` implement the plan-as-contract fields (issue #865): opt-in freeze scope, rollback-point resolution/recording, and the slice invariants gate, respectively
