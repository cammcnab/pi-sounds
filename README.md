# pi-sounds

`pi-sounds` is a Pi extension that adds sound effects and a `/sounds` dashboard.

This repo is self-contained for the core sounds experience:
- the extension code is included
- bundled sound themes are included
- runtime config is created automatically

## Features

- sound effects for Pi events
- `/sounds` dashboard for settings and previews
- `/sounds status` for quick diagnostics
- do-not-disturb support for:
  - meeting apps
  - Fellow meetings, when Fellow support is available in Pi
  - night mute after a chosen hour

## Install

From GitHub:

```bash
pi install https://github.com/cammcnab/pi-sounds
```

From a local checkout:

```bash
pi install /path/to/pi-sounds
```

Then run `/reload` in Pi.

## Commands

- `/sounds`
- `/sounds status`

## Bundled assets

This repo includes bundled sound themes under `themes/`.

The extension will use:
1. user themes in `~/.pi/sounds/themes/` when present
2. bundled themes from this repo otherwise

Runtime config is stored in:

- `~/.pi/sounds/config.json`

## Notes

- Playback currently uses macOS `afplay`.
- Fellow-based DND is optional and only works when Fellow support is available in Pi.
- Desktop notifications are not part of this extension.

## Attribution

Bundled theme assets were seeded from `ryparker/claude-code-sounds`.
See `LICENSE`.
