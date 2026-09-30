# dsh-partition-board · an interactive partition board for DSH

A [DSH](https://github.com/deepseek-ai) plugin the AI calls **on its own** when it needs a human to
settle *how things are divided in space*: page regions, poster composition, report sections,
data grouping. The model opens a canvas in the browser, the human draws the regions, the model
fills in the gaps, and the confirmed plan (legend + geometry + feathering + grid matrix) comes
back to the model as something it can act on.

Chinese docs: [README.md](./README.md). Changelog: [CHANGELOG.md](./CHANGELOG.md).

## Why the AI actually uses it

- The tool description carries **recognizable triggers**, including action-level ones:
  *"you are about to write more than 3 lines describing a layout — stop and open the board"*,
  *"you are about to ask the user more than 2 spatial questions"*, and the user's own words
  (*"I can't explain it"*, *"draw me a picture"*).
- **Cheap first call**: `purpose` + `task` + `ask` is enough. Omit `legend` and the board seeds
  four standby colours the human can rename.
- **Non-blocking**: the call returns immediately; when the human draws, reworks or confirms, the
  model receives a `[partition-board] {...}` message with `kind = plan-request | rework | confirmed`.
- **Self-correcting protocol errors**: `mode="review"` without a `boardId` is rejected with an
  error that spells out both ways forward.

## What the human gets

- A **colour legend** (colour ↔ meaning) that is the board's semantic base — colour alone means nothing;
- **Rect / lasso / soft brush / eraser**, per-region **edge feathering** for fuzzy boundaries;
- **Notes while drawing**: write the constraint graphics cannot express ("the main area must show
  two cards side by side") and it travels with the message as top-level `note`;
- **Zoom (Ctrl/⌘ + wheel, 1–8×) and pan** (Pan tool), `0` to reset — plain wheel still scrolls the chat;
- The canvas repaints on container resize (`ResizeObserver`), so strokes never stretch;
- `role="application"` canvas, `aria-live` status strip, `aria-pressed` tool buttons;
- Chinese/English UI, chosen from `<html lang>` → `navigator.language`.

## Install

```powershell
# 1) link the directory into the profile (same as `dsh plugin --profile web add link:<dir>`)
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-partition-board" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-partition-board"

# 2) in ~/.dsh/profiles/web/package.json add:
#    dependencies:        "dsh-partition-board": "link:C:/Users/<you>/.dsh/plugins/dsh-partition-board"
#    dsh.profile.bundles: append "dsh-partition-board"

# 3) ready. On DSH 0.1.6-alpha.2 the host hot-loads the new profile row (tools + skill).
#    If hot-loading does not fire on your build, restart `dsh web`.
```

Self-check before installing:

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-partition-board"
npm test       # 72 tests: 35 pure functions + 37 headless renders
npm run verify # 8 install-time contract checks
```

`tests/render.test.mjs` runs the real component through a minimal React (hooks, refs, event
dispatch, effect cleanup) and asserts **the message actually sent to the model**, plus the
layout regression captured from a board a human drew and confirmed.

## Round trip

```
model calls partition_board({purpose, task, ask, legend?})
        ↓  returns immediately (never blocks)
board opens; human names colours + draws + tunes feathering + writes notes
        ↓  conversation.send("[partition-board] {...}")
model receives kind = plan-request | rework | confirmed
        ↓  first two: same boardId, revision+1, mode="review"
        ↓  last one: plan in hand → write the code / outline / classification rules
```

`boardId` + `revision` are the only hard constraints: `review` without `boardId` is **rejected**
(with an error that says what to do), `draw` without it opens a fresh board.

## Licence

MIT. The board keeps its state in browser `localStorage` only; there is deliberately no
host-side storage (a third-party client plugin cannot obtain the browser session's credentials
in DSH 0.1.6, and a self-made route without cookie validation would be an unauthenticated
endpoint on the user's machine).
