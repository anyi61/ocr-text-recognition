---
name: bugfix-review
description: Use this skill when collaborating with another model (for example GLM) on bug fixes. It enforces root-cause-first changes, lifecycle safety checks, event/DOM interaction checks, regression gates, and a strict review handoff format to reduce rework and repeated regressions.
---

# Bugfix Review

## When to use

Use this skill when a user asks to:
- produce a bugfix plan for another model to execute,
- review another model's patch,
- run multi-round fix -> review -> re-fix workflows,
- reduce repeated regressions in UI/extension/frontend behavior.

## Output contract

Always output in this order:
1. Findings (severity ordered, file/line anchored)
2. Root cause (one paragraph each finding)
3. Minimal fix plan (step list, no broad refactor)
4. Regression checklist (must-pass)
5. Handoff prompt (copy-paste for executor model)

If no findings: explicitly say `No findings` and list remaining test gaps.

## Non-negotiable checks

For each changed file, validate all applicable checks:

### A) Lifecycle and ownership
- `init / cleanup / fullCleanup` responsibilities are distinct.
- Session cleanup does not destroy resources needed by post-action UI.
- Global cleanup removes listeners, timers, and hosts exactly once.

### B) Event hit-testing and interaction chain
- Verify container and child `pointer-events` are intentional.
- Verify `z-index` layering keeps interactive UI reachable.
- Verify no transparent top-layer remains after workflow end.

### C) Mount scope consistency
- If using Shadow DOM, all query/append/remove logic is in `shadowRoot` scope.
- Do not mix `document.getElementById` for nodes mounted in shadow.
- Add safe initialization guard before mount (`if !root -> init`).

### D) State machine integrity
- Key states (for example `isCapturing`, `isEditMode`, cancel flags) transition correctly.
- Success, cancel, and failure flows each leave UI in valid state.
- Re-entry works (run flow repeatedly without stale state).

### E) Accessibility and keyboard parity
- Interactive controls have visible focus (`:focus-visible`).
- Keyboard path exists where mouse path exists (when required by feature).
- ARIA labels remain aligned with current language/i18n system.

### F) i18n and string safety
- Newly added user-facing strings use i18n API.
- Key coverage is symmetric across locales.
- Avoid empty fallback text for missing keys.

## Risk patterns to actively hunt

- "Fix A, break B" due to shared cleanup function.
- Moving to Shadow DOM without moving selector scope.
- Making host container interactive instead of only interactive children.
- Duplicate UI stacking because old node lookup misses real mount scope.
- Patch updates visuals but not event/listener lifecycle.

## Minimal fix policy

When proposing fixes:
- Prefer smallest change set that closes the finding.
- Do not redesign architecture unless user asked.
- Preserve existing working paths; change only failing edge.
- Add one defensive guard when it prevents repeat regressions.

## Regression checklist template

Use this exact checklist in reviews (mark pass/fail):
- Syntax check passes (`node --check` or equivalent).
- Happy path works.
- Cancel path works.
- Failure path works.
- Repeat run 5x has no stale overlay/listener/state.
- Page remains interactive after flow ends.
- i18n strings render in both zh/en for touched UI.

## Handoff prompt template (for executor model)

Use this template, replacing placeholders:

```text
Task: Fix [BUG TITLE]
Scope: Only modify [FILES]

Root cause:
- [ROOT CAUSE 1]

Must change:
1) [STEP 1]
2) [STEP 2]
3) [STEP 3]

Do not change:
- [NON-GOAL 1]
- [NON-GOAL 2]

Self-test required:
A. [TEST 1]
B. [TEST 2]
C. [TEST 3]

Output format:
- changed files
- key diffs
- test results (pass/fail)
```

## Review response style

- Be direct and concrete.
- Cite exact file and line.
- Prioritize regressions and behavioral breakage over style.
- Keep summaries short; findings first.
