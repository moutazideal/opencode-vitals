# Contributing

Thanks for wanting to help. This is a small project with one rule that outranks
every other: **it must never break OpenCode.** The readout is a nicety and the
Arabic fix is a nicety; the editor is the product. A change that can leave the
window unable to open is not worth the feature it adds.

## What this plugin is

Two things, in one renderer copy and one launcher entry:

1. **The readout** — turns, steps and average streaming tok/s, drawn in the
   app's own composer from OpenCode's event stream.
2. **Arabic text** — `unicode-bidi: plaintext` and `dir="auto"` on message blocks
   and the composer, so Arabic reads and aligns right-to-left while code and
   paths stay left-to-right.

The mechanism is the same for both: the app loads its renderer from
`ELECTRON_RENDERER_URL` when it is set, so the plugin serves a copy of the app's
`out/renderer` with a few files added beside the app's own bundle, and a
`.desktop` entry points the app at it.

## Getting set up

Needs Node 22 and, to run against the real app, the OpenCode desktop app.

```bash
git clone https://github.com/moutazideal/opencode-vitals
cd opencode-vitals
npm install            # for the pinned @opencode/plugin and @opencode/schema
npm test               # the whole suite (493 checks)
```

Other commands:

```bash
npm run compat         # does every event this plugin handles still exist?
npm run test:compat    # the same, as an assertion
node selftest.mjs      # can this machine show the readout? writes nothing
npx opencode-vitals status
```

Running the plugin from source without publishing: copy or symlink the folder
into `~/.config/opencode/plugins/opencode-vitals`, which OpenCode loads with no
configuration. `--link` here, not a copy, so edits are live.

## The rules the code already keeps

These are not style preferences; they are the reasons the suite has the checks it
has. A pull request is expected to keep them.

- **Every behaviour has a test, and the fix comes with it.** A bug fix without a
  test that fails before it is a fix that can come back.
- **The suite is the count in the README.** `README.md` says how many checks
  pass; a check added or removed updates that number. There is a check that
  enforces this, so it will fail if you forget.
- **No dead code, and no export nobody reads.** An export that only exists to be
  an export is a second copy of the truth, and the two drift.
- **Comments say why, not what.** If a line is obvious, it does not need a
  comment; if it is subtle, the comment is the subtle part.
- **Failures degrade, they do not crash.** The readout server lives inside
  OpenCode's own service process, so an unhandled error there is not a missing
  feature, it is a broken editor. Guard the edges: a missing file, a malformed
  request, a port already taken.
- **The plugin never stores prompts or responses.** If a change touches
  measurement, keep it that way, and never ask for conversation text in an issue.

## The compatibility pin

OpenCode's plugin API moves with the app. The scheduled
`.github/workflows/opencode-compat.yml` job opens an issue when a new
`@opencode/plugin` is published, tests against it, and says whether the events
this plugin matches on still exist. When it is green, the fix is to move the pin
in `package.json`:

```bash
npm install --save-dev @opencode/plugin@<version> @opencode/schema@<version>
npm test && npm run compat
```

Both move together; the plugin carries the schema that matches the host that will
load it.

## The renderer and the launcher

The tests build a synthetic `app.asar` and point the plugin at it, so most work
here can be done without the desktop app. If your change touches the injection or
the copy, run the suite first: it exercises the asar reader, the tag injection,
the atomic rebuild, the launcher-entry naming and the server directly.

Two constraints are worth knowing before you design a feature:

- **There is one launcher entry.** It is what points the app at the renderer, so
  whatever owns it owns how OpenCode starts. Anything that needs the window to
  load from somewhere else has to live in that one entry.
- **The window is the app's own.** The injected files run inside the real
  renderer with the real DOM. They must assume the DOM can change between
  OpenCode releases, and never assume a selector exists.

## Releases

The version in `package.json` is the single source of truth. Bump it, add the
`CHANGELOG.md` entry, commit and push to `main`; the release workflow cuts the
tag, publishes the GitHub release from the changelog, and skips a version that is
already tagged. npm is a separate, manual step.

## Reporting

- Bugs and "does the readout appear here?" go through the
  [issue templates](https://github.com/moutazideal/opencode-vitals/issues/new/choose).
  The selftest output answers most of the question on its own.
- Security problems: see [SECURITY.md](SECURITY.md). Please do not open a public
  issue for one.
- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
