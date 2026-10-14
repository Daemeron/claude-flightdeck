# Changelog

## Unreleased

## 0.4.2 (Daemeron fork)

This version number is the fork's own (Daemeron/claude-flightdeck), so `claude plugin update` picks up its changes; it is not an upstream release.

- Docked, an open gate drill-down (`f` `s` `o`) lists more than the last 5 checks when the pane has rows to spare: it takes up to half of the rows the session log would get above its 4-line floor, never more than the checks of that family it keeps, and the log takes the rest. The row budget charges the drill-down at its new size, so the pane still fits its height. Set `dockFill` to `false` for the old 5.

## 0.4.1 (Daemeron fork)

This version number is the fork's own (Daemeron/claude-flightdeck), so `claude plugin update` picks up its changes; it is not an upstream release.

- Docked, the session log grows into the rows the other panels leave instead of stopping at 8 lines, up to the 60 lines it keeps. Set `dockFill` to `false` for the old 8-line log.
- The docked row budget counts what each panel really draws (the main box's four lines, the architect's wrapped moments and advice, the connector rows, cards' full height, the receipt, the expanded card's wrapped text) and skips panels that are hidden, so a filled log never pushes the pane past its height. With `dockFill` off the log keeps its 4-8 range, sized by the same budget.
- The inline summary uses all 8 of its rows: the rows its other lines leave show the newest session-log lines (filtered like the docked log while you view a subagent's transcript), and the first line adds effort, permission mode, request count and the first two rate-limit windows where the width allows. Set `miniFill` to `false` for the compact summary.

## 0.4.0

- The main box shows the time left until each rate-limit window resets (`5h ▰▱▱▱▱ 19% ↻3h10m`), from the `resetsAt` the session already reports. Below 56 columns the gauges stay as they were. ([#3](https://github.com/scasella/claude-flightdeck/pull/3), thanks @vihrea1337)
- The main box shows the last main-loop request's time to first token and decode speed (`last req  ttft 0.8s · 60 tok/s`), timed as its response streams past. ([#1](https://github.com/scasella/claude-flightdeck/issues/1))
- The session log has a one-row gap above it, in both layouts. ([#2](https://github.com/scasella/claude-flightdeck/issues/2))

## 0.3.2

- A background architect's advice is read from its `SubagentHandback` tool call, where the report actually arrives, with the hand-back text as a fallback. Bold markers no longer leak into the advice line.
- README: no longer promises that counters survive every update; a change to the state's shape may reset them once.

## 0.3.1

- The main box shows the model and effort as soon as a request starts, not after the first one finishes.
- Advice from a background architect agent (such as `fable-advisor`) now reaches the architect's `»` line; it arrives as a hand-back message, not as the agent's own answer.
- New README media showing the Flightdeck header; plainer wording about opening on start.
- More gate tests (24 in all).

## 0.3.0

First public release.

- Panels: main vitals (context, compactions, cost, rate limits), architect timeline, permission gate strip with per-family drill-down, agent cards and swimlanes, other loops, turn receipt, session log.
- Layouts: docked one- or two-column, and an 8-row inline summary for the main screen. Cards fall back to swimlanes when they don't fit.
- Theme colours by default, with a `pastel` palette option.
- Animated connectors and live clocks as surface modules, only while work flows.
- Works on the terminal, desktop app, VS Code and mobile surfaces.
- Config for the architect pattern, labels, panels, layout, card limit, motion, moments, palette, opening on start and the status line.
- `/clear` and `/flightdeck reset` start the pane fresh; reads tolerate missing or older fields.
