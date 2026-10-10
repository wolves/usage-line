# usage-line

A Claude Code mod that keeps your usage in view, right-aligned in the band above the prompt:

```
5h 42% (2h 30m) | wk 12% | ctx 85% | Opus 5.5 | high | Advisor: off
```

- **5h**: the five-hour rate-limit window, with the time until it resets
- **wk**: the seven-day window
- **ctx**: how full the context window is
- the model, the effort level, and the advisor model (`off` when none is set)

A figure at or past the warning threshold turns bold red, and a toast fires once when a figure crosses each threshold. It fires again only after the figure drops back below that threshold, for example after a window resets or a compaction.

## Install

```
/plugin install usage-line --marketplace wolves/usage-line
```

Answer `y` to add the marketplace, then pick a scope. The user scope loads it in every session.

## Options

Set these in `/config`:

| Option | Default | What it does |
| --- | --- | --- |
| Warn at (%) | 80 | Turns a figure red and sends the first toast |
| Critical at (%) | 95 | Sends a second toast |

## How it updates

The band redraws only when something it shows changes:

- **Usage figures:** after each turn, and whenever a rate-limit window moves a whole point
- **Model:** on each model request in the main conversation
- **Effort and advisor:** read from `effortLevel` and `advisorModel` in settings, checked every 10 seconds and on each prompt and turn
- **Reset countdown:** when the minute changes

## Development

```sh
claude --plugin-dir .          # run a session with the mod loaded and hot-reloading
claude plugin validate .       # check the manifest and hooks module
claude plugin test .           # run hooks/*.test.ts
```

When the mod loads from this folder, Claude Code writes the API's type declarations to `.claude-plugin/types/` (gitignored). After that, `tsc -p .` type-checks it.

Two renderer details to know about when changing the colors:

- Use `ansi256(n)` (0–15 is the terminal's own palette), `#hex`, `rgb()` or a theme key. A bare name like `"yellow"` passes validation but is drawn uncolored.
- `dimColor` draws the theme's grey and replaces any `color` set beside it. It is not ANSI dim.

## License

MIT
