---
name: taskboard
description: Read and update the user's Taskboard - add boards, columns and tasks, add checklist steps under other steps, tick things off, archive them. Use whenever the user asks to put something on their board, check what is on it, or mark work as done, and when you finish a piece of work they asked you to track.
---

# Taskboard

The board lives in the user's browser. A connector process bridges it, so nothing here
touches files or a database directly - it all goes through the `taskboard_*` tools.

## Before changing anything

Call `taskboard_board` first. It returns every column, task and step with what is done, so
you know the real names before you use them. Things are addressed by name, not id.

## Rules that keep it predictable

- One task per thing the user actually wants tracked. Do not shred a request into a dozen rows.
- Steps that belong to a bigger step go **under** it - pass `under` to `taskboard_add_step`.
  That nesting is the point of the app, use it rather than a flat list of twenty steps.
- Tick a step off the moment that piece is genuinely done, not when you plan to do it.
- If a name matches more than one task the tool says so instead of guessing. Read what came
  back and use a longer name, do not retry the same call.

## When it is not connected

The tools answer with what is wrong: the connector is not running, or the board is not
listening. Tell the user which one and point them at **Connect Claude** in the board's
sidebar. Do not fall back to writing files, and do not keep retrying.
