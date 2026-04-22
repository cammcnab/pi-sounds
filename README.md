# pi-sounds

`pi-sounds` is a Pi extension that adds nostalgic sound effects and a `/sounds` dashboard.

![pi-sounds preview](./.github/pi-sounds-preview.png)

It adapts the ideas and theme assets from [`ryparker/claude-code-sounds`](https://github.com/ryparker/claude-code-sounds) for Pi's extension system and TUI workflow, with Pi-specific settings, previews, and do-not-disturb controls.

## Features

- sound effects for Pi events
- `/sounds` dashboard for settings and previews
- `/sounds status` for quick diagnostics
- do-not-disturb support for:
  - meeting apps (Zoom, Teams, Webex, FaceTime)
  - Google Workspace or Fellow meeting integration when available
  - night mute after a chosen hour

## Install

Either:

- Paste this into Pi:

  ```text
  Install this extension: https://github.com/cammcnab/pi-sounds
  ```

  Then run `/reload`.

- Or run this in your terminal, then launch Pi:

  ```bash
  pi install https://github.com/cammcnab/pi-sounds
  ```

After that, open:

- `/sounds`
- `/sounds status`

## Theme customization

The `/sounds` dashboard includes a theme picker plus an assignment grid for previewing how each theme maps sounds to Pi hooks.

![pi-sounds theme customization](./.github/pi-sounds-theme-customizations.png)

## Bundled assets

This repo includes bundled sound themes under `themes/`.

Bundled theme options:

- `aoe2` — Age of Empires II
- `cnc` — Command & Conquer
- `cod` — Call of Duty
- `diablo2` — Diablo II
- `halo` — Halo
- `league-of-legends` — League of Legends
- `mario` — Mario
- `mgs` — Metal Gear Solid
- `pokemon-gen3` — Pokemon Gen 3
- `portal` — Portal
- `short-circuit` — Short Circuit
- `star-wars` — Star Wars
- `starcraft` — StarCraft
- `wc3-peon` — Warcraft III Peon
- `wh40k` — Warhammer 40K
- `zelda-botw` — The Legend of Zelda: Breath of the Wild
- `zelda-oot` — The Legend of Zelda: Ocarina of Time

The extension uses:
1. user themes in `~/.pi/sounds/themes/` when present
2. bundled themes from this repo otherwise

Runtime config is stored in:

- `~/.pi/sounds/config.json`

## Notes

- Playback currently uses macOS `afplay`.
- Meeting-aware DND is optional; `pi-sounds` will use Google Workspace or Fellow when either one is already available in Pi.

## License

Theme assets and inspiration come from [`ryparker/claude-code-sounds`](https://github.com/ryparker/claude-code-sounds). See [`LICENSE`](./LICENSE).

