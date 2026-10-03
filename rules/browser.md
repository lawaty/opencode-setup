# Browser Automation Rules (Playwright MCP)

These rules apply whenever you use any `playwright_browser_*` tool
(navigate, snapshot, click, type, fill_form, evaluate, wait_for, etc.).

## Anti-Loop Rules (CRITICAL)
1. **Max 2 attempts per action.** If a form field fill, click, or save
   fails twice, STOP immediately and hand off to the user. Never retry a
   third time with the same or a slightly different approach.
2. **Verify before you change approach, not after.** After each attempt,
   take a snapshot (or read the form state) to learn WHY it failed before
   trying again. If the failure cause is unchanged, stop.
3. **Never brute-force in a loop.** Do not alternate between evaluate,
   fill_form, type, and click in an endless permutation. Two distinct
   approaches max, then stop.
4. **Time-box.** If an action involves more than ~5 tool calls without
   observable progress toward the goal, stop and reassess with the user.

## Preferred Tool Order for Form Filling
1. Prefer the real browser tools: `playwright_browser_type` (with
   `slowly: true` when the page uses typeahead/autocomplete) and
   `playwright_browser_fill_form`.
2. Read the form state after filling (snapshot or evaluate) to confirm the
   values actually stuck. Programmatic `input.value = ...` via
   `playwright_browser_evaluate` often does NOT trigger framework
   validation — verify and, if needed, type with the keyboard instead.
3. If a Save/Submit button is disabled, find the missing/invalid field in
   the form BEFORE clicking anything else.

## When to STOP and Hand Off to the User
Stop looping and give the user exact copy-paste content when any of these
are true:
- A required form field still won't hold a value after 2 distinct attempts.
- A typeahead/dropdown suggestion never appears after 2 attempts.
- A Save/Submit button remains disabled after every field reads as filled.
- The button/action appears to succeed (clicked) but the change does not
  persist after reload — this is a signal to stop, not to retry.
- Cloudflare / bot protection (e.g. "Just a moment...", 403) blocks the page.

When handing off, output exactly what the user needs: the target section,
the exact field values to type, and which buttons to click.

## Reporting
When you stop due to the rules above, clearly say: what succeeded, what did
not, the exact reason it failed (from the snapshot/validation state), and
the precise content the user should paste manually.