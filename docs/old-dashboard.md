# The old dashboard

What the dashboard did before the rewrite, when it was `public/` served by
`src/server.ts` (still on `main`). The new hub's dashboard should do at least
this. The math behind it lives on in `src/lib/analytics/aggregate.ts` and
`replay.ts`.

## Project colors

Each project keeps one color on every chart and page. The 8 projects with the
most time ever get the palette in order, and the rest share a gray as
"Other". The ranking is over all time, not the range shown, so switching
ranges never repaints a project.

## Overview

The main page: the total and tiles up top, then active time per day and by
hour of day (stacked by project) beside the Projects and Languages lists.
"Every day" is a GitHub-style grid of days over all time, a darker blue for
more time (under 30m, 1h, 2h, 4h, more). The Sessions table shows every
project a session worked in, most time first; hover for the split.

## Timeline

`/timeline` has every session on one page, a row per day from midnight to
midnight. Each active stretch is a bar in its project's color. Sessions
running at the same time get lanes of their own, and a subagent working in
another repo while the main thread works shows as a thin bar under its
session. Hover a bar for its time and session (the session's other bars light
up), click to open it. Zoom with the + and - buttons or ctrl + scroll. Quiet
days fold into one line. "Fit to active hours" (on by default) crops the axis
to the hours anything happened in, so the bars get more room.
On a day the clocks change (23 or 25 hours) the bars are placed right but the
hour ticks assume 24 equal hours, so they can sit up to an hour off.

## Session page

Click a session's start time in the Sessions table, or a bar on the
timeline, to open `/session?id=<sessionId>`:

- **Session timeline:** lanes for you writing prompts (hollow when the draft
  was abandoned), Claude's turns and tool calls, with interrupts marked. Zoom
  with the + and - buttons, or ctrl + scroll (or pinch) to zoom around the
  cursor. "Collapse gaps" squeezes every quiet stretch over 5 minutes into a
  narrow band labelled with how long it was.
- **Drafts:** every typed draft with its writing time, edits, fixes, rewrites,
  word deletes and longest pause. Click one to replay it.
- **Replay:** the prompt box rebuilt from hook-analytics' edit timeline, drawn
  as shapes. Each letter is a block and blanks and newlines are gaps, so you
  see word shapes but never the text. Play, scrub, step edit by edit (or use
  space and the arrow keys), and squash long pauses. Under it, a strip shows
  every edit over time: typing above the line, deleting below, pastes in
  green, cursor moves as small ticks.

Languages come from the extensions of `file_changed` paths. Tools come from
`tool` rows, with errors, denials and average duration shown in the tooltip.
