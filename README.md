# pi-sounds

A shareable Pi package that adds sound effects and a `/sounds` control panel to Pi.

## Features

- Sound effects for Pi lifecycle and tool events
- A single `/sounds` dashboard for configuration
- Theme browsing with live preview
- Sound-category testing from the TUI
- Hybrid do-not-disturb behavior:
  - **Night mute** after a configurable local hour
  - **Fellow DND** for meeting-aware muting
  - **Meeting Apps DND** fallback based on running apps
- Lightweight `/sounds status` diagnostics

## Commands

- `/sounds` — open the interactive sounds dashboard
- `/sounds status` — print current config and DND diagnostics

## Dashboard controls

In the main `/sounds` dashboard:

- `space` toggles boolean settings
- `←` / `→` quick-adjust volume, meeting lead time, and night-mute hour
- `enter` opens pickers and deeper views

The DND section is grouped as a tree in the menu for readability.

## Requirements

### 1. Pi
This package is meant to be installed into Pi as a package.

### 2. macOS audio playback
`pi-sounds` currently plays audio with macOS `afplay`.

### 3. Sound themes
Sound themes are read from:

- `~/.pi/sounds/themes/`

Runtime config is stored at:

- `~/.pi/sounds/config.json`

If the config file does not exist yet, `pi-sounds` creates it with sensible defaults.

### 4. Fellow support for meeting-aware DND
For **Fellow DND**, this package expects Fellow support to come from the installed Shopify `shop-pi-fy` package.

It looks for Fellow support in this order:

1. `~/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/fellow/`
2. `~/.pi/agent/extensions/fellow/`

If Fellow is unavailable, the sounds extension still works; only the Fellow-specific DND behavior is skipped.

## Installation

### Local development install

```bash
pi install /Users/cam.mcnab/Code/pi-sounds
```

Then run `/reload` inside Pi.

Because Pi loads local packages directly from the filesystem path, edits in this repo are picked up after `/reload`.

### Install from GitHub

```bash
pi install https://github.com/cammcnab/pi-sounds
```

This repository is currently private, so coworkers will need access to the repo before installing from GitHub.

## Current defaults

- Theme: `starcraft`
- Volume: `0.7`
- Meeting Apps DND: enabled
- Fellow DND: enabled
- Meeting lead time: `2m`
- Night mute: enabled
- Night mute cutoff: `9pm`

## Repo layout

```text
pi-sounds/
├── extensions/
│   └── sounds.ts
├── .gitignore
├── package.json
└── README.md
```

## Notes

- Desktop notifications are intentionally **not** part of this repo.
- This repo is focused only on the sounds experience.
- The extension is packaged as a Pi package so it can be shared with coworkers and also used locally through a path-based install.
