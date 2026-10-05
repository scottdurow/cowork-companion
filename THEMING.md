# Restyle / recolor — OKLCH preset reference

Read this whenever you need to color an app at the token level — **both** on a turn-1 build (the app-builder
agent's Color rule, Step 1) and when the user asks to restyle, recolor, or retheme an existing app.
**PASTE a preset below — do NOT derive OKLCH by hand.**

**Fonts stay local:** Geist is pre-bundled; the offline sandbox cannot fetch CDN fonts
(`@import` / `<link>`), and tenant CSP may also block them — a restyle must not add them.

## How to retheme

One `Edit` (or one `Write`) of `src/index.css`. Set the five existing brand values — **`--primary` /
`--primary-foreground` / `--accent` / `--accent-foreground` / `--ring`** — plus the selected palette's
canvas, raised-surface, edge, and light muted-text values, each wrapped in `oklch(...)`.

Paste into **all three** token blocks, or an OS-dark user keeps the old colors:
- `:root { … }` — light theme → use the **`:root` (×5)** column plus the palette's Light atmosphere values.
- `.dark { … }` — explicit dark toggle → use the **`.dark` (×5)** column plus the palette's Dark atmosphere triplet.
- `@media (prefers-color-scheme: dark) { :root:not(.light) { … } }` — the OS-dark mirror that themes the
  first paint before any toggle wires up. Paste the **same `.dark` (×5)** values and Dark atmosphere
  triplet here as in `.dark` (the mirror and the `.dark` class must agree).

## Preset table

Every primary/foreground and accent/foreground pair below meets at least 4.5:1 contrast. Primary and ring
colors maintain at least 3:1 graphical contrast against their theme background. All colors stay within sRGB.
The parenthetical labels describe each hue's visual posture for explicit requests; they do not participate
in turn-1 palette selection.

| Hue (posture) | `:root` (×5) | `.dark` (×5) |
|---|---|---|
| **Indigo** (structured, precise) | `.47 .16 265` / `.99 0 0` / `.90 .04 265` / `.38 .13 265` / `.47 .16 265` | `.63 .16 265` / `.15 .01 265` / `.26 .05 265` / `.9 .03 265` / `.63 .16 265` |
| **Teal** (calm, analytical) | `.45 .07 195` / `.99 0 0` / `.95 .03 195` / `.38 .06 195` / `.45 .07 195` | `.64 .1 195` / `.15 .01 195` / `.26 .04 195` / `.9 .03 195` / `.64 .1 195` |
| **Violet** (expressive, exploratory) | `.46 .18 300` / `.99 0 0` / `.95 .02 300` / `.4 .14 300` / `.46 .18 300` | `.64 .18 300` / `.15 .01 300` / `.27 .06 300` / `.9 .04 300` / `.64 .18 300` |
| **Green** (grounded, reassuring) | `.45 .12 150` / `.99 0 0` / `.95 .04 150` / `.38 .1 150` / `.45 .12 150` | `.64 .13 150` / `.15 .01 150` / `.26 .05 150` / `.9 .04 150` / `.64 .13 150` |
| **Amber** (warm, energetic) | `.509 .11 70` / `.99 0 0` / `.96 .02 70` / `.42 .08 70` / `.509 .11 70` | `.76 .15 70` / `.18 .03 70` / `.3 .06 70` / `.92 .05 70` / `.76 .15 70` |
| **Rose** (urgent, human) | `.42 .17 25` / `.99 0 0` / `.96 .01 25` / `.4 .14 25` / `.42 .17 25` | `.64 .17 25` / `.15 .01 25` / `.27 .06 25` / `.9 .04 25` / `.64 .17 25` |

**Turn-1 palette selection:** an explicitly requested supported hue wins. Otherwise, use the rows above
in table order, parse the first two hexadecimal characters of the stable UUID directory in
`apps/<uuid>/` — never an `[app_N]` display alias — as one byte, and choose the row at
`byte modulo palette row count`. For another requested hue, use the closest validated preset for the
tokens and use the requested hue only as an accessible secondary or decorative accent.

**Charts:** set `--chart-1..5` to `oklch(.6 .1 <H>)`, `oklch(.65 .1 200)`, `oklch(.6 .14 150)`,
`oklch(.65 .13 70)`, `oklch(.6 .16 25)` (`<H>` = your primary's hue). These colors stay within
sRGB. Place charts on `bg-card` / Raised surfaces, where they maintain at least 3:1 graphical contrast
in both light and dark themes. The `@media`
OS-dark block carries its own `--chart-*` / `--sidebar-*` tokens, so set those there too for a complete
non-indigo OS-dark theme. **Radius:** tune the single `--radius`, and see the packs below.

## Shape & type packs

Hue alone does not make two apps look different — **shape and type do.** Pick ONE row below in addition
to a hue: `--radius` lives in `:root` only (one line), and `--font-heading` in `@theme inline` defines
the `font-heading` utility. It changes only the elements where that utility is applied.

| Pack (fits) | `--radius` | `--font-heading` | Heading style in JSX |
|---|---|---|---|
| **Sharp** (consoles, admin, dense data) | `0.375rem` | `var(--font-sans)` | tight, small, `uppercase tracking-wide` labels |
| **Standard** (general purpose) | `0.625rem` | `var(--font-sans)` | the scaffold default |
| **Editorial** (reports, reading-first, summaries) | `0.5rem` | `Georgia, Cambria, "Times New Roman", Times, serif` | large and `font-light`, generous whitespace |
| **Soft** (consumer, trackers, boards) | `1.25rem` | `var(--font-sans)` | `font-bold`, roomy padding, `rounded-full` on pills |

**Turn-1 pack selection (semantic, with deterministic tie-breaking):** an explicitly requested supported
visual style wins. For another requested style, use the closest compatible validated pack and express the
requested style only through existing utilities and composition. Otherwise, first keep only packs compatible with the app's visual thesis, density, and
boldness ceiling. When one pack clearly fits, use it. When several fit equally, keep only those tied packs
in table order, parse the second hexadecimal character of the stable UUID directory in `apps/<uuid>/` —
never an `[app_N]` display alias — as a value from 0 to 15, and choose the tied pack at
`value modulo tied-pack count`. The pack supports the same design direction; it is not an independent random axis.

**Fonts must stay local.** The stacks above are either the bundled Geist (`var(--font-sans)`) or
**system** families already present on the machine — they need no download and work offline. Never add a
CDN font (`@import` / `<link>`); the offline sandbox cannot fetch it, and tenant CSP may also block it.
Tailwind's
`font-serif` / `font-mono` utilities resolve to system stacks too and are safe for the same reason.

## Palette atmosphere profiles

After selecting a palette row, paste that row's matching atmosphere values in the same edit.
Set `--background` to Canvas, both `--card` and `--popover` to Raised, and both `--border`
and `--input` to Edge. In `:root`, also set `--muted-foreground` to Light Muted Text.
Paste the dark values into both `.dark` and the OS-dark mirror.

| Hue | Light Canvas | Light Raised | Light Edge | Light Muted Text | Dark Canvas | Dark Raised | Dark Edge |
|---|---|---|---|---|---|---|---|
| **Indigo** | `0.975 0 265` | `0.993 0.002 265` | `0.84 0.045 265` | `0.47 0 0` | `0.13 0.025 265` | `0.19 0.03 265` | `0.34 0.05 265` |
| **Teal** | `0.91 0.03 195` | `0.993 0.002 195` | `0.84 0.035 195` | `0.50 0 0` | `0.13 0.02 195` | `0.19 0.025 195` | `0.34 0.04 195` |
| **Violet** | `0.91 0.025 300` | `0.993 0.002 300` | `0.84 0.045 300` | `0.50 0 0` | `0.13 0.025 300` | `0.19 0.03 300` | `0.34 0.05 300` |
| **Green** | `0.91 0.03 150` | `0.993 0.002 150` | `0.84 0.04 150` | `0.50 0 0` | `0.13 0.02 150` | `0.19 0.025 150` | `0.34 0.045 150` |
| **Amber** | `0.91 0.03 70` | `0.993 0.002 70` | `0.85 0.05 70` | `0.50 0 0` | `0.15 0.025 70` | `0.20 0.03 70` | `0.36 0.055 70` |
| **Rose** | `0.91 0.023 25` | `0.993 0.002 25` | `0.84 0.045 25` | `0.50 0 0` | `0.13 0.025 25` | `0.19 0.03 25` | `0.34 0.05 25` |

Paste each triplet as `oklch(...)` verbatim. Keep page and structural regions on
`bg-background`, raised content on `bg-card` or `bg-popover`, and edges on
`border-border`; fixed `bg-white` or neutral backgrounds erase the selected palette
and break dark mode.

Setting `--font-heading` in the `@theme inline` block generates a **`font-heading` utility** — headings do
not pick it up automatically, so put `className="font-heading"` on your `<h1>`/`<h2>`/card titles when the
pack changes the family. Leave body text on `--font-sans`.


In JSX use **semantic** utilities (`bg-primary`, `text-muted-foreground`, `border-border`, `text-chart-1`)
— never raw `oklch(...)` / hex. A restrained two-stop gradient from the brand hue
(`bg-gradient-to-br from-primary to-accent`) is welcome on ONE hero surface — never rainbow gradients or a
gradient on every card.
