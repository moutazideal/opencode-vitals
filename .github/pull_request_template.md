<!--
Thanks for the pull request. Keep it small and explain the why; the code already
says what it does. The checklist below is the one this project actually enforces.
-->

## What this changes, and why

<!-- One or two paragraphs. Link the issue it fixes, if there is one. -->

## Checklist

- [ ] `npm test` passes.
- [ ] If a check was added or removed, the count in `README.md` was updated to
      match (there is a check that enforces this).
- [ ] A bug fix comes with a test that fails before it and passes after.
- [ ] User-visible changes are noted in `CHANGELOG.md`.
- [ ] No dead code, and no export, file or option that nothing reads.
- [ ] It cannot make OpenCode fail to open: the renderer rebuild still goes
      beside the old copy and moves into place, and a failure still leaves the
      app as it was.
- [ ] No prompts or responses are stored, logged or sent — this plugin never
      does, and neither should a contribution.
- [ ] If it touches the events this plugin handles, `npm run compat` is clean.

## Notes for the reviewer

<!-- Anything subtle, or a decision you were unsure about. -->
