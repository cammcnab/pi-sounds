import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, type SelectItem } from "@mariozechner/pi-tui";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";

type FellowAuthModule = {
  getToken: () => Promise<string>;
};

type FellowMcpModule = {
  callTool: (
    name: string,
    args: Record<string, unknown>,
    token: string,
  ) => Promise<{ content?: Array<{ text?: string }> }>;
};

type SoundCategory =
  | "start"
  | "end"
  | "prompt"
  | "stop"
  | "permission"
  | "idle"
  | "subagent"
  | "error"
  | "task-completed"
  | "compact"
  | "teammate-idle";

type ThemeJson = {
  name?: string;
  description?: string;
  sounds?: Partial<Record<SoundCategory, { description?: string; files?: Array<{ name?: string }> }>>;
};

type SoundConfig = {
  enabled: boolean;
  theme: string;
  volume: number;
  dndEnabled: boolean;
  dndProcesses: string[];
  fellowDndEnabled: boolean;
  fellowLeadMinutes: number;
  nightMuteEnabled: boolean;
  muteAfterHour: number;
};

type FellowMeeting = {
  meeting_id?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
};

const SOUND_ROOT = path.join(os.homedir(), ".pi", "sounds");
const THEMES_DIR = path.join(SOUND_ROOT, "themes");
const CONFIG_PATH = path.join(SOUND_ROOT, "config.json");
const SHOP_PI_FY_FELLOW_DIR = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "git",
  "github.com",
  "shopify-playground",
  "shop-pi-fy",
  "extensions",
  "fellow",
);
const MAIN_EXTENSIONS_FELLOW_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "fellow");
const FELLOW_AUTH_CANDIDATES = [
  path.join(SHOP_PI_FY_FELLOW_DIR, "auth.ts"),
  path.join(MAIN_EXTENSIONS_FELLOW_DIR, "auth.ts"),
];
const FELLOW_MCP_CANDIDATES = [
  path.join(SHOP_PI_FY_FELLOW_DIR, "mcp.ts"),
  path.join(MAIN_EXTENSIONS_FELLOW_DIR, "mcp.ts"),
];
const DEFAULT_DND_PROCESSES = ["zoom.us", "Zoom", "Microsoft Teams", "Teams", "Webex", "FaceTime"];
const DEFAULT_CONFIG: SoundConfig = {
  enabled: true,
  theme: "starcraft",
  volume: 0.7,
  dndEnabled: true,
  dndProcesses: DEFAULT_DND_PROCESSES,
  fellowDndEnabled: true,
  fellowLeadMinutes: 2,
  nightMuteEnabled: true,
  muteAfterHour: 21,
};
const MIN_PLAY_GAP_MS = 150;
const DND_CACHE_MS = 10000;
const FELLOW_DND_CACHE_MS = 15000;
const MAX_MEETING_DURATION_MS = 6 * 60 * 60 * 1000;

let lastPlayAt = 0;
let lastDndCheckAt = 0;
let lastDndActive = false;
let lastFellowCheckAt = 0;
let lastFellowDndActive = false;
let lastFellowMeetingCount = 0;
let lastFellowDndError: string | undefined;
let fellowAuthModulePromise: Promise<FellowAuthModule> | undefined;
let fellowMcpModulePromise: Promise<FellowMcpModule> | undefined;
let lastDashboardIndex = 0;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.volume;
  return Math.max(0, Math.min(1, value));
}

function normalizeProcessList(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_DND_PROCESSES];
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return items.length > 0 ? items : [...DEFAULT_DND_PROCESSES];
}

function normalizeConfig(value: Partial<SoundConfig> | null | undefined): SoundConfig {
  return {
    enabled: value?.enabled ?? DEFAULT_CONFIG.enabled,
    theme: value?.theme?.trim() || DEFAULT_CONFIG.theme,
    volume: clampVolume(value?.volume ?? DEFAULT_CONFIG.volume),
    dndEnabled: value?.dndEnabled ?? DEFAULT_CONFIG.dndEnabled,
    dndProcesses: normalizeProcessList(value?.dndProcesses),
    fellowDndEnabled: value?.fellowDndEnabled ?? DEFAULT_CONFIG.fellowDndEnabled,
    fellowLeadMinutes: Math.max(0, Math.min(30, Number(value?.fellowLeadMinutes ?? DEFAULT_CONFIG.fellowLeadMinutes) || DEFAULT_CONFIG.fellowLeadMinutes)),
    nightMuteEnabled: value?.nightMuteEnabled ?? DEFAULT_CONFIG.nightMuteEnabled,
    muteAfterHour: Math.max(0, Math.min(23, Number(value?.muteAfterHour ?? DEFAULT_CONFIG.muteAfterHour) || 0)),
  };
}

async function saveConfig(config: SoundConfig): Promise<void> {
  await fs.mkdir(SOUND_ROOT, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function ensureConfig(): Promise<SoundConfig> {
  await fs.mkdir(SOUND_ROOT, { recursive: true });

  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const config = normalizeConfig(JSON.parse(raw) as Partial<SoundConfig>);
    return config;
  } catch {
    await saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

async function listInstalledThemes(): Promise<string[]> {
  try {
    const entries = await fs.readdir(THEMES_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readTheme(theme: string): Promise<ThemeJson | null> {
  try {
    const themePath = path.join(THEMES_DIR, theme, "theme.json");
    const raw = await fs.readFile(themePath, "utf8");
    return JSON.parse(raw) as ThemeJson;
  } catch {
    return null;
  }
}

function pickRandom<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function isSoundCategory(value: string): value is SoundCategory {
  return [
    "start",
    "end",
    "prompt",
    "stop",
    "permission",
    "idle",
    "subagent",
    "error",
    "task-completed",
    "compact",
    "teammate-idle",
  ].includes(value);
}

async function resolveSoundFile(theme: string, category: SoundCategory): Promise<string | null> {
  const themeJson = await readTheme(theme);
  const candidates = themeJson?.sounds?.[category]?.files?.map((file) => file.name).filter(Boolean) as string[] | undefined;
  const picked = pickRandom(candidates ?? []);
  if (!picked) return null;

  const filePath = path.join(THEMES_DIR, theme, "sounds", picked);
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function isProcessDndActive(config: SoundConfig): Promise<boolean> {
  if (!config.dndEnabled || config.dndProcesses.length === 0) {
    return false;
  }

  const now = Date.now();
  if (now - lastDndCheckAt < DND_CACHE_MS) {
    return lastDndActive;
  }

  lastDndCheckAt = now;

  try {
    const stdout = await execFileText("ps", ["-axo", "comm="]);
    const running = new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const base = path.basename(line);
          return [line.toLowerCase(), base.toLowerCase()];
        }),
    );

    lastDndActive = config.dndProcesses.some((name) => running.has(name.toLowerCase()));
    return lastDndActive;
  } catch {
    lastDndActive = false;
    return false;
  }
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractMeetingsFromText(text: string): FellowMeeting[] {
  const trimmed = text.trim();
  const match = trimmed.match(/>(\[.*\])<\//s);
  const jsonText = match?.[1] ?? (trimmed.startsWith("[") ? trimmed : "");
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? (parsed as FellowMeeting[]) : [];
  } catch {
    return [];
  }
}

function isActiveMeeting(meeting: FellowMeeting, now: Date, leadMinutes: number): boolean {
  if (!meeting.start_time || !meeting.end_time) return false;

  const start = new Date(meeting.start_time);
  const end = new Date(meeting.end_time);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;

  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration > MAX_MEETING_DURATION_MS) return false;

  const bufferedStart = start.getTime() - leadMinutes * 60 * 1000;
  return now.getTime() >= bufferedStart && now.getTime() <= end.getTime();
}

async function importFirstAvailableModule<T>(candidatePaths: string[]): Promise<T> {
  const errors: string[] = [];

  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(candidatePath);
      return (await import(pathToFileURL(candidatePath).href)) as T;
    } catch (error) {
      errors.push(`${candidatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Unable to load Fellow module from known locations:\n${errors.join("\n")}`);
}

async function loadFellowModules(): Promise<{ auth: FellowAuthModule; mcp: FellowMcpModule }> {
  fellowAuthModulePromise ??= importFirstAvailableModule<FellowAuthModule>(FELLOW_AUTH_CANDIDATES);
  fellowMcpModulePromise ??= importFirstAvailableModule<FellowMcpModule>(FELLOW_MCP_CANDIDATES);
  const [auth, mcp] = await Promise.all([fellowAuthModulePromise, fellowMcpModulePromise]);
  return { auth, mcp };
}

async function isFellowDndActive(config: SoundConfig): Promise<boolean> {
  if (!config.fellowDndEnabled) return false;

  const now = Date.now();
  if (now - lastFellowCheckAt < FELLOW_DND_CACHE_MS) {
    return lastFellowDndActive;
  }

  lastFellowCheckAt = now;

  try {
    const { auth, mcp } = await loadFellowModules();
    const token = await auth.getToken();
    const today = localDateString(new Date());
    const result = await mcp.callTool(
      "search_meetings",
      { from_date: today, to_date: today, user_has_calendar_event: true },
      token,
    );

    const text = result.content?.map((item: { text?: string }) => item.text ?? "").join("\n") ?? "";
    const meetings = extractMeetingsFromText(text);
    lastFellowMeetingCount = meetings.length;
    lastFellowDndError = undefined;
    lastFellowDndActive = meetings.some((meeting) => isActiveMeeting(meeting, new Date(), config.fellowLeadMinutes));
    return lastFellowDndActive;
  } catch (error) {
    lastFellowMeetingCount = 0;
    lastFellowDndError = error instanceof Error ? error.message : String(error);
    lastFellowDndActive = false;
    return false;
  }
}

function formatHourLabel(hour24: number): string {
  const normalized = ((hour24 % 24) + 24) % 24;
  const suffix = normalized >= 12 ? "pm" : "am";
  const hour12 = normalized % 12 || 12;
  return `${hour12}${suffix}`;
}

function isNightMuteActive(config: SoundConfig, now = new Date()): boolean {
  if (!config.nightMuteEnabled) return false;
  return now.getHours() >= config.muteAfterHour;
}

async function isDndActive(config: SoundConfig): Promise<boolean> {
  if (isNightMuteActive(config)) {
    return true;
  }

  if (await isFellowDndActive(config)) {
    return true;
  }

  return isProcessDndActive(config);
}

async function playSoundFile(filePath: string, volume: number): Promise<void> {
  const now = Date.now();
  if (now - lastPlayAt < MIN_PLAY_GAP_MS) return;

  lastPlayAt = now;
  const child = spawn("afplay", ["-v", String(clampVolume(volume)), filePath], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

async function playThemeCategory(theme: string, category: SoundCategory, volume: number): Promise<boolean> {
  const filePath = await resolveSoundFile(theme, category);
  if (!filePath) return false;
  await playSoundFile(filePath, volume);
  return true;
}

async function playThemePreview(theme: string, volume: number): Promise<void> {
  const themeJson = await readTheme(theme);
  const preferredCategories = Object.keys(themeJson?.sounds ?? {})
    .filter(isSoundCategory)
    .filter((category) => !["idle", "teammate-idle"].includes(category));
  const categories = preferredCategories.length > 0 ? preferredCategories : ["start", "prompt", "stop"];
  const category = pickRandom(categories as SoundCategory[]);
  if (!category) return;
  await playThemeCategory(theme, category, volume);
}

async function playCategory(category: SoundCategory, options?: { bypassDnd?: boolean }): Promise<void> {
  const config = await ensureConfig();
  if (!config.enabled) return;

  if (!options?.bypassDnd && (await isDndActive(config))) {
    return;
  }

  await playThemeCategory(config.theme, category, config.volume);
}

function looksDangerousBashCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return ["sudo ", "rm -rf", "git push", "gt submit", "chmod ", "chown ", "mv ", "gcloud auth", "gh auth"]
    .some((fragment) => normalized.includes(fragment));
}

function isPermissionLikeToolCall(event: { toolName?: string; input?: unknown }): boolean {
  const toolName = event.toolName ?? "";

  if (["gcal_manage", "gmail_manage", "gdoc_create", "gdoc_write", "gdoc_edit", "slack_post"].includes(toolName)) {
    return true;
  }

  if (toolName === "bash") {
    const input = event.input as { command?: unknown } | undefined;
    return typeof input?.command === "string" && looksDangerousBashCommand(input.command);
  }

  return false;
}

function isTodoCompletion(event: { toolName?: string; input?: unknown; isError?: boolean }): boolean {
  if (event.toolName !== "todo" || event.isError) return false;

  const input = event.input as { action?: unknown; status?: unknown } | undefined;
  const action = typeof input?.action === "string" ? input.action : "";
  const status = typeof input?.status === "string" ? input.status.toLowerCase() : "";

  if (!["update", "create"].includes(action)) return false;
  return ["done", "completed", "closed"].includes(status);
}

function formatDndStatus(config: SoundConfig, fellowActive: boolean, processActive: boolean): string {
  return [
    `theme=${config.theme}`,
    `volume=${Math.round(config.volume * 100)}%`,
    `nightMute=${config.nightMuteEnabled ? "on" : "off"}${config.nightMuteEnabled ? ` (active=${isNightMuteActive(config) ? "yes" : "no"}, after=${formatHourLabel(config.muteAfterHour)})` : ""}`,
    `fellowDnd=${config.fellowDndEnabled ? "on" : "off"}${config.fellowDndEnabled ? ` (active=${fellowActive ? "yes" : "no"}, lead=${config.fellowLeadMinutes}m, meetings=${lastFellowMeetingCount})` : ""}`,
    `meetingAppsDnd=${config.dndEnabled ? "on" : "off"}${config.dndEnabled ? ` (active=${processActive ? "yes" : "no"})` : ""}`,
    `fellowStatus=${lastFellowDndError ? `error: ${lastFellowDndError}` : "ok"}`,
    `fellowRefresh=${FELLOW_DND_CACHE_MS / 1000}s`,
  ].join("\n");
}

type SoundsDashboardView = "main" | "theme" | "volume" | "lead" | "muteAfter" | "test" | "status";

type MainDashboardAction = "theme" | "volume" | "enabled" | "dnd" | "lead" | "fellowDnd" | "processDnd" | "nightMute" | "muteAfter" | "test" | "status";

const QUICK_VOLUME_STEPS = [0, 0.1, 0.25, 0.5, 0.7, 1];
const QUICK_LEAD_STEPS = [0, 1, 2, 5, 10];
const QUICK_MUTE_AFTER_HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);
const MAX_SOUNDS_MENU_VISIBLE = 14;
const SOUND_TEST_CATEGORIES: SoundCategory[] = [
  "start",
  "prompt",
  "stop",
  "permission",
  "subagent",
  "error",
  "task-completed",
  "compact",
  "end",
];

function stepIndex<T>(items: T[], current: T, direction: -1 | 1): T {
  const index = items.findIndex((item) => item === current);
  if (index === -1) {
    return items[0] as T;
  }
  const nextIndex = Math.max(0, Math.min(items.length - 1, index + direction));
  return items[nextIndex] as T;
}

function isLeftInput(data: string, kb: { matches: (data: string, action: string) => boolean }): boolean {
  return kb.matches(data, "tui.editor.cursorLeft") || data === "\u001b[D" || data === "\u001bOD";
}

function isRightInput(data: string, kb: { matches: (data: string, action: string) => boolean }): boolean {
  return kb.matches(data, "tui.editor.cursorRight") || data === "\u001b[C" || data === "\u001bOC";
}

function buildMainDashboardItems(config: SoundConfig, fellowActive: boolean, processActive: boolean): SelectItem[] {
  return [
    { value: "theme", label: `Theme: ${config.theme}`, description: "Enter to browse themes • arrowing in the theme picker previews samples" },
    { value: "volume", label: `Volume: ${Math.round(config.volume * 100)}%`, description: "←→ quick adjust • Enter for fixed steps" },
    { value: "enabled", label: `Sounds: ${config.enabled ? "on" : "off"}`, description: "Space toggles all sound effects" },
    { value: "dnd", label: `DND: ${config.dndEnabled || config.fellowDndEnabled || config.nightMuteEnabled ? "on" : "off"}`, description: "Space toggles all automatic muting" },
    { value: "lead", label: `  ├─ Meeting lead time: ${config.fellowLeadMinutes}m`, description: "←→ quick adjust • Enter for fixed steps" },
    { value: "fellowDnd", label: `  ├─ Fellow DND: ${config.fellowDndEnabled ? "on" : "off"}`, description: `Fellow is ${fellowActive ? "currently active" : "currently idle"}` },
    { value: "processDnd", label: `  ├─ Meeting Apps DND: ${config.dndEnabled ? "on" : "off"}`, description: `Meeting apps are ${processActive ? "currently active" : "currently idle"}` },
    { value: "nightMute", label: `  ├─ Night mute: ${config.nightMuteEnabled ? "on" : "off"}`, description: `Mute all sounds after ${formatHourLabel(config.muteAfterHour)}` },
    { value: "muteAfter", label: `  └─ Mute after: ${formatHourLabel(config.muteAfterHour)}`, description: "←→ quick adjust • Enter for hour picker" },
    { value: "test", label: "Test sound", description: "Enter to open the tester • space previews in the test menu" },
    { value: "status", label: "Status", description: "Open live Fellow / DND diagnostics" },
  ];
}

async function showSoundsDashboard(ctx: any, config: SoundConfig, fellowActive: boolean, processActive: boolean): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, kb, done) => {
    let currentConfig = config;
    let currentFellowActive = fellowActive;
    let currentProcessActive = processActive;
    let view: SoundsDashboardView = "main";
    let mainIndex = lastDashboardIndex;
    let themeIndex = 0;
    let volumeIndex = Math.max(0, QUICK_VOLUME_STEPS.findIndex((step) => step === currentConfig.volume));
    let leadIndex = Math.max(0, QUICK_LEAD_STEPS.findIndex((step) => step === currentConfig.fellowLeadMinutes));
    let muteAfterIndex = Math.max(0, QUICK_MUTE_AFTER_HOURS.findIndex((hour) => hour === currentConfig.muteAfterHour));
    let testIndex = 0;
    let selectList: SelectList | null = null;

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };

    const currentSummary = () =>
      `Theme ${currentConfig.theme} • Volume ${Math.round(currentConfig.volume * 100)}% • Fellow ${currentFellowActive ? "active" : "idle"} • Process ${currentProcessActive ? "active" : "idle"}`;

    const currentHelp = () => {
      switch (view) {
        case "main":
          return "↑↓ move • space toggle • ←→ quick adjust • enter menu • esc close";
        case "theme":
          return "↑↓ browse + preview • space preview • enter choose • esc back";
        case "test":
          return "↑↓ choose sound • space preview • enter preview • esc back";
        case "volume":
        case "lead":
        case "muteAfter":
          return "↑↓ choose value • space/enter apply • esc back";
        case "status":
          return "space refresh • esc back";
      }
    };

    const refreshPresence = async () => {
      currentFellowActive = await isFellowDndActive(currentConfig);
      currentProcessActive = await isProcessDndActive(currentConfig);
    };

    const persistConfig = async (nextConfig: SoundConfig, refreshDnd = false) => {
      currentConfig = nextConfig;
      volumeIndex = Math.max(0, QUICK_VOLUME_STEPS.findIndex((step) => step === currentConfig.volume));
      leadIndex = Math.max(0, QUICK_LEAD_STEPS.findIndex((step) => step === currentConfig.fellowLeadMinutes));
      muteAfterIndex = Math.max(0, QUICK_MUTE_AFTER_HOURS.findIndex((hour) => hour === currentConfig.muteAfterHour));
      await saveConfig(currentConfig);
      if (refreshDnd) {
        lastFellowCheckAt = 0;
        lastDndCheckAt = 0;
        await refreshPresence();
      }
      rebuildList();
      tui.requestRender();
    };

    const currentMainAction = (): MainDashboardAction => {
      const items = buildMainDashboardItems(currentConfig, currentFellowActive, currentProcessActive);
      return (items[Math.max(0, Math.min(mainIndex, items.length - 1))]?.value as MainDashboardAction) ?? "status";
    };

    const applyMainQuickAction = async (direction?: -1 | 1) => {
      switch (currentMainAction()) {
        case "enabled":
          await persistConfig({ ...currentConfig, enabled: !currentConfig.enabled });
          return;
        case "dnd": {
          const next = !(currentConfig.dndEnabled || currentConfig.fellowDndEnabled || currentConfig.nightMuteEnabled);
          await persistConfig({ ...currentConfig, dndEnabled: next, fellowDndEnabled: next, nightMuteEnabled: next }, true);
          return;
        }
        case "fellowDnd":
          await persistConfig({ ...currentConfig, fellowDndEnabled: !currentConfig.fellowDndEnabled }, true);
          return;
        case "processDnd":
          await persistConfig({ ...currentConfig, dndEnabled: !currentConfig.dndEnabled }, true);
          return;
        case "nightMute":
          await persistConfig({ ...currentConfig, nightMuteEnabled: !currentConfig.nightMuteEnabled }, true);
          return;
        case "volume": {
          if (!direction) return;
          const nextVolume = stepIndex(QUICK_VOLUME_STEPS, currentConfig.volume, direction);
          await persistConfig({ ...currentConfig, volume: nextVolume });
          await playCategory("stop", { bypassDnd: true });
          return;
        }
        case "lead": {
          if (!direction) return;
          const nextLead = stepIndex(QUICK_LEAD_STEPS, currentConfig.fellowLeadMinutes, direction);
          await persistConfig({ ...currentConfig, fellowLeadMinutes: nextLead }, true);
          return;
        }
        case "muteAfter": {
          if (!direction) return;
          const nextHour = stepIndex(QUICK_MUTE_AFTER_HOURS, currentConfig.muteAfterHour, direction);
          await persistConfig({ ...currentConfig, muteAfterHour: nextHour }, true);
          return;
        }
        default:
          return;
      }
    };

    const rebuildList = () => {
      if (view === "main") {
        const items = buildMainDashboardItems(currentConfig, currentFellowActive, currentProcessActive);
        selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
        mainIndex = Math.max(0, Math.min(mainIndex, items.length - 1));
        lastDashboardIndex = mainIndex;
        selectList.setSelectedIndex(mainIndex);
        selectList.onSelectionChange = (item) => {
          const index = items.findIndex((candidate) => candidate.value === item.value);
          if (index >= 0) {
            mainIndex = index;
            lastDashboardIndex = index;
          }
        };
        selectList.onSelect = () => {
          switch (currentMainAction()) {
            case "theme":
              view = "theme";
              break;
            case "volume":
              view = "volume";
              break;
            case "lead":
              view = "lead";
              break;
            case "muteAfter":
              view = "muteAfter";
              break;
            case "test":
              view = "test";
              break;
            case "status":
              view = "status";
              break;
            default:
              void applyMainQuickAction();
              return;
          }
          rebuildList();
          tui.requestRender();
        };
        selectList.onCancel = () => done(undefined);
        return;
      }

      if (view === "volume") {
        const items = QUICK_VOLUME_STEPS.map((step) => ({
          value: String(step),
          label: `${Math.round(step * 100)}%`,
          description: step === currentConfig.volume ? "Current volume" : "Set output volume",
        }));
        selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
        volumeIndex = Math.max(0, QUICK_VOLUME_STEPS.findIndex((step) => step === currentConfig.volume));
        selectList.setSelectedIndex(volumeIndex);
        selectList.onSelectionChange = (item) => {
          const index = items.findIndex((candidate) => candidate.value === item.value);
          if (index >= 0) volumeIndex = index;
        };
        selectList.onSelect = () => {
          const value = QUICK_VOLUME_STEPS[volumeIndex] ?? currentConfig.volume;
          void (async () => {
            await persistConfig({ ...currentConfig, volume: value });
            await playCategory("stop", { bypassDnd: true });
            view = "main";
            rebuildList();
            tui.requestRender();
          })();
        };
        selectList.onCancel = () => {
          view = "main";
          rebuildList();
          tui.requestRender();
        };
        return;
      }

      if (view === "lead") {
        const items = QUICK_LEAD_STEPS.map((step) => ({
          value: String(step),
          label: `${step}m`,
          description: step === currentConfig.fellowLeadMinutes ? "Current lead time" : "Mute this many minutes before meetings",
        }));
        selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
        leadIndex = Math.max(0, QUICK_LEAD_STEPS.findIndex((step) => step === currentConfig.fellowLeadMinutes));
        selectList.setSelectedIndex(leadIndex);
        selectList.onSelectionChange = (item) => {
          const index = items.findIndex((candidate) => candidate.value === item.value);
          if (index >= 0) leadIndex = index;
        };
        selectList.onSelect = () => {
          const value = QUICK_LEAD_STEPS[leadIndex] ?? currentConfig.fellowLeadMinutes;
          void (async () => {
            await persistConfig({ ...currentConfig, fellowLeadMinutes: value }, true);
            view = "main";
            rebuildList();
            tui.requestRender();
          })();
        };
        selectList.onCancel = () => {
          view = "main";
          rebuildList();
          tui.requestRender();
        };
        return;
      }

      if (view === "muteAfter") {
        const items = QUICK_MUTE_AFTER_HOURS.map((hour) => ({
          value: String(hour),
          label: formatHourLabel(hour),
          description: hour === currentConfig.muteAfterHour ? "Current cutoff" : "Mute sounds at and after this hour",
        }));
        selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
        muteAfterIndex = Math.max(0, QUICK_MUTE_AFTER_HOURS.findIndex((hour) => hour === currentConfig.muteAfterHour));
        selectList.setSelectedIndex(muteAfterIndex);
        selectList.onSelectionChange = (item) => {
          const index = items.findIndex((candidate) => candidate.value === item.value);
          if (index >= 0) muteAfterIndex = index;
        };
        selectList.onSelect = () => {
          const value = QUICK_MUTE_AFTER_HOURS[muteAfterIndex] ?? currentConfig.muteAfterHour;
          void (async () => {
            await persistConfig({ ...currentConfig, muteAfterHour: value }, true);
            view = "main";
            rebuildList();
            tui.requestRender();
          })();
        };
        selectList.onCancel = () => {
          view = "main";
          rebuildList();
          tui.requestRender();
        };
        return;
      }

      if (view === "test") {
        const items = SOUND_TEST_CATEGORIES.map((category) => ({
          value: category,
          label: category,
          description: `Preview '${category}' in the ${currentConfig.theme} theme`,
        }));
        selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
        testIndex = Math.max(0, Math.min(testIndex, items.length - 1));
        selectList.setSelectedIndex(testIndex);
        selectList.onSelectionChange = (item) => {
          const index = items.findIndex((candidate) => candidate.value === item.value);
          if (index >= 0) testIndex = index;
        };
        selectList.onSelect = () => {
          const category = items[testIndex]?.value as SoundCategory | undefined;
          if (!category) return;
          void playCategory(category, { bypassDnd: true });
        };
        selectList.onCancel = () => {
          view = "main";
          rebuildList();
          tui.requestRender();
        };
        return;
      }

      if (view === "theme") {
        selectList = null;
        void (async () => {
          const themes = await listInstalledThemes();
          if (themes.length === 0) {
            view = "main";
            ctx.ui.notify("No sound themes installed in ~/.pi/sounds/themes", "error");
            rebuildList();
            tui.requestRender();
            return;
          }

          const items = themes.map((themeName) => ({
            value: themeName,
            label: themeName,
            description: themeName === currentConfig.theme ? "Current theme" : "Preview with arrow keys or space",
          }));
          selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
          themeIndex = Math.max(0, themes.indexOf(currentConfig.theme));
          selectList.setSelectedIndex(themeIndex);
          selectList.onSelectionChange = (item) => {
            const index = items.findIndex((candidate) => candidate.value === item.value);
            if (index >= 0) themeIndex = index;
            void playThemePreview(item.value, currentConfig.volume);
          };
          selectList.onSelect = () => {
            const themeName = items[themeIndex]?.value;
            if (!themeName) return;
            void (async () => {
              await persistConfig({ ...currentConfig, theme: themeName });
              view = "main";
              rebuildList();
              tui.requestRender();
            })();
          };
          selectList.onCancel = () => {
            view = "main";
            rebuildList();
            tui.requestRender();
          };
          tui.requestRender();
        })();
        return;
      }

      selectList = null;
    };

    void refreshPresence().then(() => {
      rebuildList();
      tui.requestRender();
    });
    rebuildList();

    const body = {
      render(width: number) {
        const lines = [
          theme.fg("accent", theme.bold("Pi sounds")),
          theme.fg("muted", currentSummary()),
          "",
        ];

        if (view === "status") {
          lines.push(...formatDndStatus(currentConfig, currentFellowActive, currentProcessActive).split("\n").map((line) => theme.fg("muted", line)));
        } else if (selectList) {
          lines.push(...selectList.render(width));
        }

        lines.push("");
        lines.push(theme.fg("dim", currentHelp()));
        return lines;
      },
      invalidate() {
        selectList?.invalidate?.();
      },
      handleInput(data: string) {
        if (view === "status") {
          if (kb.matches(data, "tui.select.cancel")) {
            view = "main";
            rebuildList();
            tui.requestRender();
            return;
          }
          if (data === " " || kb.matches(data, "tui.select.confirm")) {
            void refreshPresence().then(() => tui.requestRender());
          }
          return;
        }

        if (view === "main") {
          if (data === " ") {
            void applyMainQuickAction();
            return;
          }
          if (isLeftInput(data, kb)) {
            void applyMainQuickAction(-1);
            return;
          }
          if (isRightInput(data, kb)) {
            void applyMainQuickAction(1);
            return;
          }
        }

        if (view === "theme" && data === " ") {
          const item = selectList?.getSelectedItem();
          if (item) {
            void playThemePreview(item.value, currentConfig.volume);
          }
          return;
        }

        if (view === "test" && data === " ") {
          const item = selectList?.getSelectedItem();
          if (item && isSoundCategory(item.value)) {
            void playCategory(item.value, { bypassDnd: true });
          }
          return;
        }

        if ((view === "volume" || view === "lead" || view === "muteAfter") && data === " ") {
          selectList?.onSelect?.(selectList.getSelectedItem() ?? { value: "", label: "" });
          return;
        }

        selectList?.handleInput(data);
        tui.requestRender();
      },
    };

    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(body);
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        body.handleInput(data);
      },
    };
  });
}

export default function soundsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sounds", {
    description: "Open the Pi sounds dashboard",
    handler: async (args, ctx) => {
      const mode = args?.trim();
      if (mode === "status") {
        const config = await ensureConfig();
        const fellowActive = await isFellowDndActive(config);
        const processActive = await isProcessDndActive(config);
        ctx.ui.notify(formatDndStatus(config, fellowActive, processActive), "info");
        return;
      }

      const config = await ensureConfig();
      const fellowActive = await isFellowDndActive(config);
      const processActive = await isProcessDndActive(config);
      await showSoundsDashboard(ctx, config, fellowActive, processActive);
    },
  });

  pi.on("session_start", async () => {
    await ensureConfig();
    await playCategory("start");
  });

  pi.on("before_agent_start", async () => {
    await playCategory("prompt");
  });

  pi.on("agent_end", async () => {
    await playCategory("stop");
  });

  pi.on("session_shutdown", async () => {
    await playCategory("end");
  });

  pi.on("session_compact", async () => {
    await playCategory("compact");
  });

  pi.on("tool_call", async (event) => {
    if (isPermissionLikeToolCall(event)) {
      await playCategory("permission");
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (["subagent", "team_spawn", "team_message"].includes(event.toolName)) {
      await playCategory("subagent");
    }
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.isError) {
      await playCategory("error");
    }
  });

  pi.on("tool_result", async (event) => {
    if (isTodoCompletion(event)) {
      await playCategory("task-completed");
    }
  });
}
