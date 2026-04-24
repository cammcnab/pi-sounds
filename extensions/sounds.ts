import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, type SelectItem } from "@mariozechner/pi-tui";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

type GworkspaceClientCredentials = {
  clientId: string;
  clientSecret: string;
};

type GworkspaceStoredTokens = {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
  granted_scopes?: string[];
};

type GworkspaceAuthModule = {
  SCOPES: {
    calendar_readonly: string;
  };
  loadClientCredentials: () => GworkspaceClientCredentials;
  loadStoredTokens: () => GworkspaceStoredTokens | null;
  saveTokens: (tokens: GworkspaceStoredTokens) => void;
  hasScope: (tokens: GworkspaceStoredTokens | null, scope: string) => boolean;
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
  author?: string;
  sources?: string[];
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

type MeetingWindow = {
  meeting_id?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
};

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_THEMES_DIR = path.resolve(EXTENSION_DIR, "..", "themes");
const SOUND_ROOT = path.join(os.homedir(), ".pi", "sounds");
const THEMES_DIR = path.join(SOUND_ROOT, "themes");
const THEME_SEARCH_DIRS = [THEMES_DIR, BUNDLED_THEMES_DIR];
const CONFIG_PATH = path.join(SOUND_ROOT, "config.json");
const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const GIT_PACKAGES_DIR = path.join(PI_AGENT_DIR, "git");
const MAIN_EXTENSIONS_FELLOW_DIR = path.join(PI_AGENT_DIR, "extensions", "fellow");
const MAIN_EXTENSIONS_GWORKSPACE_DIR = path.join(PI_AGENT_DIR, "extensions", "gworkspace");
const DEFAULT_DND_PROCESSES = ["zoom.us", "Zoom", "Microsoft Teams", "Teams", "Webex", "FaceTime"];
const DEFAULT_CONFIG: SoundConfig = {
  enabled: true,
  theme: "starcraft",
  volume: 0.2,
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
let lastMeetingCheckAt = 0;
let lastMeetingDndActive = false;
let lastGworkspaceMeetingActive = false;
let lastGworkspaceMeetingCount = 0;
let lastGworkspaceDndError: string | undefined;
let lastGworkspaceAvailable = false;
let lastFellowMeetingActive = false;
let lastFellowMeetingCount = 0;
let lastFellowDndError: string | undefined;
let lastFellowAvailable = false;
let fellowAuthModulePromise: Promise<FellowAuthModule> | undefined;
let fellowMcpModulePromise: Promise<FellowMcpModule> | undefined;
let gworkspaceAuthModulePromise: Promise<GworkspaceAuthModule> | undefined;
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listInstalledThemes(): Promise<string[]> {
  const names = new Set<string>();

  for (const themesDir of THEME_SEARCH_DIRS) {
    try {
      const entries = await fs.readdir(themesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // ignore missing theme directories
    }
  }

  return [...names].sort();
}

async function resolveThemeDirs(theme: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const themesDir of THEME_SEARCH_DIRS) {
    const themeDir = path.join(themesDir, theme);
    if (await pathExists(path.join(themeDir, "theme.json"))) {
      dirs.push(themeDir);
    }
  }
  return dirs;
}

async function resolveThemeDir(theme: string): Promise<string | null> {
  const dirs = await resolveThemeDirs(theme);
  return dirs[0] ?? null;
}

async function readThemeFile(themeDir: string): Promise<ThemeJson | null> {
  try {
    const raw = await fs.readFile(path.join(themeDir, "theme.json"), "utf8");
    return JSON.parse(raw) as ThemeJson;
  } catch {
    return null;
  }
}

function mergeThemeJson(base: ThemeJson | null, override: ThemeJson | null): ThemeJson | null {
  if (!base && !override) return null;
  if (!base) return override;
  if (!override) return base;

  const mergedSounds: NonNullable<ThemeJson["sounds"]> = { ...(base.sounds ?? {}) };
  for (const [category, value] of Object.entries(override.sounds ?? {})) {
    if (!value || !isSoundCategory(category)) continue;
    mergedSounds[category] = {
      ...(mergedSounds[category] ?? {}),
      ...value,
      files: value.files ? value.files.map((file) => ({ name: file.name })) : mergedSounds[category]?.files,
    };
  }

  return {
    ...base,
    ...override,
    sounds: mergedSounds,
  };
}

async function readTheme(theme: string): Promise<ThemeJson | null> {
  try {
    const themeDirs = await resolveThemeDirs(theme);
    let merged: ThemeJson | null = null;

    for (const themeDir of [...themeDirs].reverse()) {
      merged = mergeThemeJson(merged, await readThemeFile(themeDir));
    }

    return merged;
  } catch {
    return null;
  }
}

async function resolveThemeSoundFile(theme: string, fileName: string): Promise<string | null> {
  const themeDirs = await resolveThemeDirs(theme);
  for (const themeDir of themeDirs) {
    const filePath = path.join(themeDir, "sounds", fileName);
    if (await pathExists(filePath)) {
      return filePath;
    }
  }
  return null;
}

async function listThemeSoundFiles(theme: string): Promise<string[]> {
  const fileNames = new Set<string>();
  const themeDirs = await resolveThemeDirs(theme);

  for (const themeDir of themeDirs) {
    try {
      const entries = await fs.readdir(path.join(themeDir, "sounds"), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) fileNames.add(entry.name);
      }
    } catch {
      // ignore missing sounds directories
    }
  }

  return [...fileNames].sort();
}

async function saveThemeOverride(theme: string, themeJson: ThemeJson): Promise<void> {
  const themeDir = path.join(THEMES_DIR, theme);
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "theme.json"), `${JSON.stringify(themeJson, null, 2)}\n`, "utf8");
}

function pickRandom<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function formatSoundLabel(fileName: string): string {
  return stripFileExtension(fileName);
}

function formatThemeLabel(themeName: string): string {
  const knownThemeLabels: Record<string, string> = {
    aoe2: "Age of Empires II",
    cnc: "Command & Conquer",
    cod: "Call of Duty",
    diablo2: "Diablo II",
    halo: "Halo",
    "league-of-legends": "League of Legends",
    mario: "Mario",
    mgs: "Metal Gear Solid",
    "pokemon-gen3": "Pokemon Gen 3",
    portal: "Portal",
    "short-circuit": "Short Circuit",
    "star-wars": "Star Wars",
    starcraft: "StarCraft",
    "wc3-peon": "Warcraft III Peon",
    wh40k: "Warhammer 40K",
    "zelda-botw": "The Legend of Zelda: Breath of the Wild",
    "zelda-oot": "The Legend of Zelda: Ocarina of Time",
  };

  return (
    knownThemeLabels[themeName] ??
    themeName
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
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

  return resolveThemeSoundFile(theme, picked);
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

function extractMeetingsFromText(text: string): MeetingWindow[] {
  const trimmed = text.trim();
  const match = trimmed.match(/>(\[.*\])<\//s);
  const jsonText = match?.[1] ?? (trimmed.startsWith("[") ? trimmed : "");
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? (parsed as MeetingWindow[]) : [];
  } catch {
    return [];
  }
}

function isActiveMeeting(meeting: MeetingWindow, now: Date, leadMinutes: number): boolean {
  if (!meeting.start_time || !meeting.end_time) return false;

  const start = new Date(meeting.start_time);
  const end = new Date(meeting.end_time);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;

  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration > MAX_MEETING_DURATION_MS) return false;

  const bufferMs = leadMinutes * 60 * 1000;
  const bufferedStart = start.getTime() - bufferMs;
  const bufferedEnd = end.getTime() + bufferMs;
  return now.getTime() >= bufferedStart && now.getTime() <= bufferedEnd;
}

async function discoverExtensionModuleCandidates(extensionName: string, fileName: string): Promise<string[]> {
  const mainExtensionDir = extensionName === "fellow" ? MAIN_EXTENSIONS_FELLOW_DIR : MAIN_EXTENSIONS_GWORKSPACE_DIR;
  const candidates = [path.join(mainExtensionDir, fileName)];

  try {
    const hosts = await fs.readdir(GIT_PACKAGES_DIR, { withFileTypes: true });
    for (const host of hosts) {
      if (!host.isDirectory()) continue;
      const hostDir = path.join(GIT_PACKAGES_DIR, host.name);
      const packages = await fs.readdir(hostDir, { withFileTypes: true });
      for (const pkg of packages) {
        if (!pkg.isDirectory()) continue;
        candidates.push(path.join(hostDir, pkg.name, "extensions", extensionName, fileName));
      }
    }
  } catch {
    // ignore missing package directories
  }

  return candidates;
}

async function importFirstAvailableModule<T>(moduleName: string, candidatePaths: string[]): Promise<T> {
  const errors: string[] = [];

  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(candidatePath);
      return (await import(pathToFileURL(candidatePath).href)) as T;
    } catch (error) {
      errors.push(`${candidatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Unable to load ${moduleName} module from known locations:\n${errors.join("\n")}`);
}

async function loadFellowModules(): Promise<{ auth: FellowAuthModule; mcp: FellowMcpModule }> {
  fellowAuthModulePromise ??= discoverExtensionModuleCandidates("fellow", "auth.ts").then((paths) => importFirstAvailableModule<FellowAuthModule>("Fellow auth", paths));
  fellowMcpModulePromise ??= discoverExtensionModuleCandidates("fellow", "mcp.ts").then((paths) => importFirstAvailableModule<FellowMcpModule>("Fellow MCP", paths));
  const [auth, mcp] = await Promise.all([fellowAuthModulePromise, fellowMcpModulePromise]);
  return { auth, mcp };
}

async function loadGworkspaceAuthModule(): Promise<GworkspaceAuthModule> {
  gworkspaceAuthModulePromise ??= discoverExtensionModuleCandidates("gworkspace", "auth.ts").then((paths) => importFirstAvailableModule<GworkspaceAuthModule>("Google Workspace auth", paths));
  return gworkspaceAuthModulePromise;
}

function startOfLocalDayIso(date: Date): string {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function endOfLocalDayIso(date: Date): string {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}

function extractMeetingsFromCalendarEvents(events: Array<Record<string, any>>): MeetingWindow[] {
  return events
    .map((event) => ({
      meeting_id: typeof event.id === "string" ? event.id : undefined,
      title: typeof event.summary === "string" ? event.summary : undefined,
      start_time: typeof event.start?.dateTime === "string" ? event.start.dateTime : undefined,
      end_time: typeof event.end?.dateTime === "string" ? event.end.dateTime : undefined,
    }))
    .filter((meeting) => meeting.start_time && meeting.end_time);
}

async function refreshGworkspaceAccessTokenSilently(
  auth: GworkspaceAuthModule,
  refreshToken: string,
  grantedScopes?: string[],
): Promise<string | null> {
  let creds: GworkspaceClientCredentials;
  try {
    creds = auth.loadClientCredentials();
  } catch {
    return null;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    return null;
  }

  const data = await resp.json() as { access_token?: string; expires_in?: number; token_type?: string; scope?: string };
  if (!data.access_token) {
    return null;
  }

  auth.saveTokens({
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type ?? "Bearer",
    granted_scopes: data.scope ? data.scope.split(" ") : grantedScopes,
  });

  return data.access_token;
}

async function getGworkspaceCalendarTokenSilently(auth: GworkspaceAuthModule): Promise<string | null> {
  const stored = auth.loadStoredTokens();
  const requiredScope = auth.SCOPES.calendar_readonly;
  if (!stored || !auth.hasScope(stored, requiredScope)) {
    return null;
  }

  if (stored.expiry_date > Date.now() + 60_000) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    return null;
  }

  return refreshGworkspaceAccessTokenSilently(auth, stored.refresh_token, stored.granted_scopes);
}

async function gworkspaceCalendarFetchJson(url: string, accessToken: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google Calendar HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function listGworkspaceCalendarEvents(accessToken: string, now: Date): Promise<Array<Record<string, any>>> {
  const calendarList = await gworkspaceCalendarFetchJson("https://www.googleapis.com/calendar/v3/users/me/calendarList", accessToken);
  const calendarIds = Array.isArray(calendarList?.items)
    ? calendarList.items.map((calendar: { id?: string }) => calendar.id).filter(Boolean)
    : ["primary"];

  const timeMin = startOfLocalDayIso(now);
  const timeMax = endOfLocalDayIso(now);
  const events: Array<Record<string, any>> = [];

  for (const calendarId of calendarIds) {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
      timeMin,
      timeMax,
    });
    const encodedCalendarId = encodeURIComponent(String(calendarId));
    const data = await gworkspaceCalendarFetchJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events?${params.toString()}`,
      accessToken,
    );
    if (Array.isArray(data?.items)) {
      events.push(...data.items);
    }
  }

  return events;
}

async function isGworkspaceMeetingDndActive(config: SoundConfig): Promise<boolean> {
  try {
    const auth = await loadGworkspaceAuthModule();
    const accessToken = await getGworkspaceCalendarTokenSilently(auth);
    if (!accessToken) {
      lastGworkspaceAvailable = false;
      lastGworkspaceMeetingActive = false;
      lastGworkspaceMeetingCount = 0;
      lastGworkspaceDndError = undefined;
      return false;
    }

    const now = new Date();
    const events = await listGworkspaceCalendarEvents(accessToken, now);
    const meetings = extractMeetingsFromCalendarEvents(events);
    lastGworkspaceAvailable = true;
    lastGworkspaceMeetingCount = meetings.length;
    lastGworkspaceDndError = undefined;
    lastGworkspaceMeetingActive = meetings.some((meeting) => isActiveMeeting(meeting, now, config.fellowLeadMinutes));
    return lastGworkspaceMeetingActive;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unable to load Google Workspace auth module")) {
      lastGworkspaceAvailable = false;
      lastGworkspaceMeetingActive = false;
      lastGworkspaceMeetingCount = 0;
      lastGworkspaceDndError = undefined;
      return false;
    }

    lastGworkspaceAvailable = true;
    lastGworkspaceMeetingActive = false;
    lastGworkspaceMeetingCount = 0;
    lastGworkspaceDndError = message;
    return false;
  }
}

async function isFellowMeetingDndActive(config: SoundConfig): Promise<boolean> {
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
    lastFellowAvailable = true;
    lastFellowMeetingCount = meetings.length;
    lastFellowDndError = undefined;
    lastFellowMeetingActive = meetings.some((meeting) => isActiveMeeting(meeting, new Date(), config.fellowLeadMinutes));
    return lastFellowMeetingActive;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error instanceof Error && error.name === "NoTokenError") || message.includes("Unable to load Fellow")) {
      lastFellowAvailable = false;
      lastFellowMeetingActive = false;
      lastFellowMeetingCount = 0;
      lastFellowDndError = undefined;
      return false;
    }

    lastFellowAvailable = true;
    lastFellowMeetingCount = 0;
    lastFellowDndError = message;
    lastFellowMeetingActive = false;
    return false;
  }
}

async function isMeetingDndActive(config: SoundConfig): Promise<boolean> {
  if (!config.fellowDndEnabled) return false;

  const now = Date.now();
  if (now - lastMeetingCheckAt < FELLOW_DND_CACHE_MS) {
    return lastMeetingDndActive;
  }

  lastMeetingCheckAt = now;
  const [gworkspaceActive, fellowActive] = await Promise.all([
    isGworkspaceMeetingDndActive(config),
    isFellowMeetingDndActive(config),
  ]);

  lastMeetingDndActive = gworkspaceActive || fellowActive;
  return lastMeetingDndActive;
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

  if (await isMeetingDndActive(config)) {
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

async function buildAssignSoundRows(theme: string): Promise<AssignSoundRow[]> {
  const themeJson = await readTheme(theme);
  const rows = new Map<string, AssignSoundRow>();

  for (const fileName of await listThemeSoundFiles(theme)) {
    rows.set(fileName, {
      fileName,
      label: formatSoundLabel(fileName),
      previewPath: await resolveThemeSoundFile(theme, fileName),
      hooks: ASSIGN_SOUND_COLUMNS.map(() => false),
    });
  }

  for (const column of ASSIGN_SOUND_COLUMNS) {
    const files = themeJson?.sounds?.[column.key]?.files ?? [];
    for (const file of files) {
      const fileName = file.name?.trim();
      if (!fileName) continue;

      let row = rows.get(fileName);
      if (!row) {
        row = {
          fileName,
          label: formatSoundLabel(fileName),
          previewPath: await resolveThemeSoundFile(theme, fileName),
          hooks: ASSIGN_SOUND_COLUMNS.map(() => false),
        };
        rows.set(fileName, row);
      }

      row.hooks[columnIndex(column.key)] = true;
    }
  }

  return [...rows.values()];
}

function columnIndex(category: SoundCategory): number {
  return Math.max(0, ASSIGN_SOUND_COLUMNS.findIndex((column) => column.key === category));
}

async function playCategory(category: SoundCategory, options?: { bypassDnd?: boolean }): Promise<void> {
  const config = await ensureConfig();
  if (!config.enabled) return;

  if (!options?.bypassDnd && (await isDndActive(config))) {
    return;
  }

  await playThemeCategory(config.theme, category, config.volume);
}

async function playRandomTestSound(): Promise<void> {
  const category = pickRandom(SOUND_TEST_CATEGORIES);
  if (!category) return;
  await playCategory(category, { bypassDnd: true });
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

function formatDndStatus(config: SoundConfig, meetingActive: boolean, processActive: boolean): string {
  return [
    `theme=${config.theme}`,
    `volume=${Math.round(config.volume * 100)}%`,
    `nightMute=${config.nightMuteEnabled ? "on" : "off"}${config.nightMuteEnabled ? ` (active=${isNightMuteActive(config) ? "yes" : "no"}, after=${formatHourLabel(config.muteAfterHour)})` : ""}`,
    `meetingDnd=${config.fellowDndEnabled ? "on" : "off"}${config.fellowDndEnabled ? ` (active=${meetingActive ? "yes" : "no"}, buffer=${config.fellowLeadMinutes}m)` : ""}`,
    `meetingAppsDnd=${config.dndEnabled ? "on" : "off"}${config.dndEnabled ? ` (active=${processActive ? "yes" : "no"})` : ""}`,
    `gworkspace=${!lastGworkspaceAvailable ? "unavailable" : lastGworkspaceDndError ? `error: ${lastGworkspaceDndError}` : `ok (active=${lastGworkspaceMeetingActive ? "yes" : "no"}, events=${lastGworkspaceMeetingCount})`}`,
    `fellow=${!lastFellowAvailable ? "unavailable" : lastFellowDndError ? `error: ${lastFellowDndError}` : `ok (active=${lastFellowMeetingActive ? "yes" : "no"}, meetings=${lastFellowMeetingCount})`}`,
    `meetingRefresh=${FELLOW_DND_CACHE_MS / 1000}s`,
  ].join("\n");
}

function formatMeetingProvidersSummary(): string {
  const providers: string[] = [];
  if (lastGworkspaceAvailable && !lastGworkspaceDndError) providers.push("GCal ✓");
  if (lastFellowAvailable && !lastFellowDndError) providers.push("Fellow ✓");
  return providers.length > 0 ? ` • ${providers.join(" • ")}` : "";
}

function formatMeetingAppsSupport(processes: string[]): string {
  const labels = new Set<string>();

  for (const processName of processes) {
    const normalized = processName.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "zoom" || normalized === "zoom.us") {
      labels.add("Zoom");
    } else if (normalized === "teams" || normalized === "microsoft teams") {
      labels.add("Teams");
    } else if (normalized === "webex") {
      labels.add("Webex");
    } else if (normalized === "facetime") {
      labels.add("FaceTime");
    } else {
      labels.add(processName.trim());
    }
  }

  return [...labels].join(", ");
}

type SoundsDashboardView = "main" | "theme" | "volume" | "lead" | "muteAfter" | "test" | "status";

type MainDashboardAction = "theme" | "volume" | "enabled" | "dnd" | "lead" | "fellowDnd" | "processDnd" | "nightMute" | "muteAfter" | "test" | "status";

type HookColumn = {
  key: SoundCategory;
  abbr: string;
  description: string;
};

type AssignSoundRow = {
  fileName: string;
  label: string;
  previewPath: string | null;
  hooks: boolean[];
};

const QUICK_VOLUME_STEPS = Array.from({ length: 21 }, (_unused, index) => index / 20);
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
const ASSIGN_SOUND_COLUMNS: HookColumn[] = [
  { key: "start", abbr: "str", description: "Session starting" },
  { key: "prompt", abbr: "pmt", description: "User submitted prompt" },
  { key: "permission", abbr: "prm", description: "Permission prompt" },
  { key: "stop", abbr: "stp", description: "Done responding" },
  { key: "subagent", abbr: "sub", description: "Subagent starting" },
  { key: "task-completed", abbr: "tsk", description: "Task completed" },
  { key: "error", abbr: "err", description: "Tool failure" },
  { key: "compact", abbr: "cmp", description: "Session compacting" },
  { key: "idle", abbr: "idl", description: "Waiting for input" },
  { key: "teammate-idle", abbr: "tmt", description: "Teammate went idle" },
  { key: "end", abbr: "end", description: "Session ending" },
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

function isUpInput(data: string, kb: { matches: (data: string, action: string) => boolean }): boolean {
  return kb.matches(data, "tui.editor.cursorUp") || kb.matches(data, "tui.select.prev") || data === "\u001b[A" || data === "\u001bOA";
}

function isDownInput(data: string, kb: { matches: (data: string, action: string) => boolean }): boolean {
  return kb.matches(data, "tui.editor.cursorDown") || kb.matches(data, "tui.select.next") || data === "\u001b[B" || data === "\u001bOB";
}

function buildMainDashboardItems(config: SoundConfig, meetingActive: boolean, processActive: boolean): SelectItem[] {
  return [
    { value: "enabled", label: `Sounds: ${config.enabled ? "on" : "off"}`, description: "Space: Toggle all sound effects" },
    { value: "status", label: "Status", description: "Enter: Open live meeting / DND diagnostics" },
    { value: "volume", label: `Volume: ${Math.round(config.volume * 100)}%`, description: "←→: Adjust quickly • Enter: Choose a fixed value" },
    { value: "theme", label: `Theme: ${formatThemeLabel(config.theme)}`, description: "Enter: Browse themes • Space: Preview current theme" },
    { value: "test", label: "Assign sounds", description: "Enter: Open the assignment grid • Space: Play a random sound" },
    { value: "dnd", label: `DND: ${config.dndEnabled || config.fellowDndEnabled || config.nightMuteEnabled ? "on" : "off"}`, description: "Space: Toggle all automatic muting" },
    { value: "fellowDnd", label: `  ├─ Meeting DND: ${config.fellowDndEnabled ? "on" : "off"}`, description: `Space: Toggle meeting muting • Status: ${meetingActive ? "active" : "idle"}` },
    { value: "lead", label: `  ├─ Meeting buffer: ${config.fellowLeadMinutes}m`, description: "←→: Adjust quickly • Enter: Choose a buffer" },
    { value: "processDnd", label: `  ├─ Meeting apps DND: ${config.dndEnabled ? "on" : "off"}`, description: `${processActive ? "Space: Toggle • Status: Active now • " : "Space: Toggle • "}Watches ${formatMeetingAppsSupport(config.dndProcesses)}` },
    { value: "nightMute", label: `  ├─ Night mute: ${config.nightMuteEnabled ? "on" : "off"}`, description: `Space: Toggle • Mutes all sounds after ${formatHourLabel(config.muteAfterHour)}` },
    { value: "muteAfter", label: `  └─ Mute after: ${formatHourLabel(config.muteAfterHour)}`, description: "←→: Adjust quickly • Enter: Choose an hour" },
  ];
}

async function showSoundsDashboard(ctx: any, config: SoundConfig, meetingActive: boolean, processActive: boolean): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, kb, done) => {
    let currentConfig = config;
    let currentMeetingActive = meetingActive;
    let currentProcessActive = processActive;
    let view: SoundsDashboardView = "main";
    let mainIndex = lastDashboardIndex;
    let themeIndex = 0;
    let volumeIndex = Math.max(0, QUICK_VOLUME_STEPS.findIndex((step) => step === currentConfig.volume));
    let leadIndex = Math.max(0, QUICK_LEAD_STEPS.findIndex((step) => step === currentConfig.fellowLeadMinutes));
    let muteAfterIndex = Math.max(0, QUICK_MUTE_AFTER_HOURS.findIndex((hour) => hour === currentConfig.muteAfterHour));
    let assignRows: AssignSoundRow[] = [];
    let assignThemeDraft: ThemeJson | null = null;
    let assignDirty = false;
    let assignCursorRow = 0;
    let assignCursorCol = 0;
    let assignScrollTop = 0;
    let assignError: string | null = null;
    let assignLoading = false;
    let selectList: SelectList | null = null;

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };

    const currentSummary = () =>
      `Theme ${formatThemeLabel(currentConfig.theme)} • Volume ${Math.round(currentConfig.volume * 100)}% • Meetings ${currentMeetingActive ? "active" : "idle"}${formatMeetingProvidersSummary()}`;

    const currentHelp = () => {
      switch (view) {
        case "main":
          return "↑↓ move • space toggle • ←→ quick adjust • enter menu • esc close";
        case "theme":
          return "↑↓ browse • space preview • enter preview + choose • esc back";
        case "test":
          return "↑↓ sounds • ←→ hooks • enter toggle assignment • space preview • esc save + back";
        case "volume":
        case "lead":
        case "muteAfter":
          return "↑↓ choose value • space/enter apply • esc back";
        case "status":
          return "space refresh • esc back";
      }
    };

    const refreshPresence = async () => {
      currentMeetingActive = await isMeetingDndActive(currentConfig);
      currentProcessActive = await isProcessDndActive(currentConfig);
    };

    const persistConfig = async (nextConfig: SoundConfig, refreshDnd = false) => {
      currentConfig = nextConfig;
      volumeIndex = Math.max(0, QUICK_VOLUME_STEPS.findIndex((step) => step === currentConfig.volume));
      leadIndex = Math.max(0, QUICK_LEAD_STEPS.findIndex((step) => step === currentConfig.fellowLeadMinutes));
      muteAfterIndex = Math.max(0, QUICK_MUTE_AFTER_HOURS.findIndex((hour) => hour === currentConfig.muteAfterHour));
      await saveConfig(currentConfig);
      if (refreshDnd) {
        lastMeetingCheckAt = 0;
        lastDndCheckAt = 0;
        await refreshPresence();
      }
      rebuildList();
      tui.requestRender();
    };

    const currentMainAction = (): MainDashboardAction => {
      const items = buildMainDashboardItems(currentConfig, currentMeetingActive, currentProcessActive);
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
        case "theme":
          await playThemePreview(currentConfig.theme, currentConfig.volume);
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
        case "test":
          await playRandomTestSound();
          return;
        default:
          return;
      }
    };

    const rebuildList = () => {
      if (view === "main") {
        const items = buildMainDashboardItems(currentConfig, currentMeetingActive, currentProcessActive);
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
          description: step === currentConfig.fellowLeadMinutes ? "Current meeting buffer" : "Mute this many minutes before and after calendar meetings",
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
        selectList = null;
        assignLoading = true;
        assignError = null;
        assignRows = [];
        assignDirty = false;
        void (async () => {
          try {
            assignThemeDraft = await readTheme(currentConfig.theme);
            assignRows = await buildAssignSoundRows(currentConfig.theme);
            assignCursorRow = Math.max(0, Math.min(assignCursorRow, Math.max(0, assignRows.length - 1)));
            assignCursorCol = Math.max(0, Math.min(assignCursorCol, ASSIGN_SOUND_COLUMNS.length - 1));
            assignScrollTop = Math.max(0, Math.min(assignScrollTop, Math.max(0, assignRows.length - 1)));
          } catch (error) {
            assignError = error instanceof Error ? error.message : String(error);
          } finally {
            assignLoading = false;
            tui.requestRender();
          }
        })();
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
            label: formatThemeLabel(themeName),
            description: themeName === currentConfig.theme ? "Current theme" : "Space previews • Enter applies",
          }));
          selectList = new SelectList(items, Math.min(items.length, MAX_SOUNDS_MENU_VISIBLE), listTheme);
          themeIndex = Math.max(0, themes.indexOf(currentConfig.theme));
          selectList.setSelectedIndex(themeIndex);
          selectList.onSelectionChange = (item) => {
            const index = items.findIndex((candidate) => candidate.value === item.value);
            if (index >= 0) themeIndex = index;
          };
          selectList.onSelect = () => {
            const themeName = items[themeIndex]?.value;
            if (!themeName) return;
            void (async () => {
              await playThemePreview(themeName, currentConfig.volume);
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

    const previewAssignSound = () => {
      const row = assignRows[assignCursorRow];
      if (!row?.previewPath) return;
      void playSoundFile(row.previewPath, currentConfig.volume);
    };

    const toggleAssignSound = () => {
      const row = assignRows[assignCursorRow];
      const hook = ASSIGN_SOUND_COLUMNS[assignCursorCol];
      if (!row || !hook) return;

      assignThemeDraft ??= { sounds: {} };
      assignThemeDraft.sounds ??= {};

      const existingEntry = assignThemeDraft.sounds[hook.key] ?? {};
      const existingFiles = (existingEntry.files ?? [])
        .map((file) => file.name?.trim())
        .filter((name): name is string => Boolean(name));
      const isAssigned = existingFiles.includes(row.fileName);
      const nextFiles = isAssigned ? existingFiles.filter((name) => name !== row.fileName) : [...existingFiles, row.fileName];

      assignThemeDraft.sounds[hook.key] = {
        ...existingEntry,
        files: nextFiles.map((name) => ({ name })),
      };
      row.hooks[assignCursorCol] = !isAssigned;
      assignDirty = true;
      assignError = null;
      tui.requestRender();
    };

    const saveAssignChanges = async (): Promise<boolean> => {
      if (!assignDirty || !assignThemeDraft) return true;

      try {
        await saveThemeOverride(currentConfig.theme, assignThemeDraft);
        assignDirty = false;
        return true;
      } catch (error) {
        assignError = error instanceof Error ? error.message : String(error);
        tui.requestRender();
        return false;
      }
    };

    const renderAssignSoundGrid = (width: number): string[] => {
      if (assignLoading) {
        return [theme.fg("muted", "Loading sound assignment grid…")];
      }

      if (assignError) {
        return [theme.fg("warning", `Unable to load sound assignments: ${assignError}`)];
      }

      if (assignRows.length === 0) {
        return [theme.fg("muted", `No sounds found for ${formatThemeLabel(currentConfig.theme)}.`)];
      }

      const colWidth = 4;
      let labelWidth = Math.min(30, Math.max(18, width - 24));
      const linePrefix = 2;
      const totalCols = ASSIGN_SOUND_COLUMNS.length;
      const visibleCols = Math.max(1, Math.min(totalCols, Math.floor((width - linePrefix - labelWidth - 2) / colWidth)));
      const needsHScroll = visibleCols < totalCols;

      if (assignCursorCol < 0) assignCursorCol = 0;
      if (assignCursorCol >= totalCols) assignCursorCol = totalCols - 1;
      if (assignCursorRow < 0) assignCursorRow = 0;
      if (assignCursorRow >= assignRows.length) assignCursorRow = assignRows.length - 1;

      let colStart = 0;
      if (needsHScroll) {
        colStart = Math.max(0, Math.min(assignCursorCol - Math.floor(visibleCols / 2), totalCols - visibleCols));
      }
      const showLeftArrow = needsHScroll && colStart > 0;
      const showRightArrow = needsHScroll && colStart + visibleCols < totalCols;
      const leftMargin = needsHScroll ? (showLeftArrow ? theme.fg("dim", "◂") : " ") : "";
      const rightMargin = needsHScroll ? (showRightArrow ? theme.fg("dim", "▸") : " ") : "";

      const maxVisibleRows = 10;
      if (assignCursorRow < assignScrollTop) assignScrollTop = assignCursorRow;
      if (assignCursorRow >= assignScrollTop + maxVisibleRows) assignScrollTop = assignCursorRow - maxVisibleRows + 1;
      assignScrollTop = Math.max(0, Math.min(assignScrollTop, Math.max(0, assignRows.length - maxVisibleRows)));

      const lines: string[] = [];
      const sectionLabel = `── ${formatThemeLabel(currentConfig.theme)} ─`;
      lines.push(theme.fg("dim", sectionLabel.padEnd(Math.max(sectionLabel.length, width - 2), "─")));

      let headerLine = " ".repeat(labelWidth) + leftMargin;
      for (let column = colStart; column < colStart + visibleCols; column++) {
        const abbr = ASSIGN_SOUND_COLUMNS[column]?.abbr ?? "";
        const cell = abbr.padStart(colWidth);
        headerLine += column === assignCursorCol ? theme.fg("accent", theme.bold(cell)) : theme.fg("dim", cell);
      }
      headerLine += rightMargin;
      lines.push(headerLine);

      const visibleRows = assignRows.slice(assignScrollTop, assignScrollTop + maxVisibleRows);
      for (let index = 0; index < visibleRows.length; index++) {
        const absoluteIndex = assignScrollTop + index;
        const row = visibleRows[index];
        const isActiveRow = absoluteIndex === assignCursorRow;
        const pointer = isActiveRow ? theme.fg("accent", "›") : " ";
        const rawLabel = row.label.length > labelWidth - 3 ? `${row.label.slice(0, labelWidth - 4)}…` : row.label;
        let line = `${pointer} ${isActiveRow ? theme.fg("accent", rawLabel.padEnd(labelWidth - 2, " ")) : theme.fg("muted", rawLabel.padEnd(labelWidth - 2, " "))}${leftMargin}`;

        for (let column = colStart; column < colStart + visibleCols; column++) {
          const isChecked = row.hooks[column];
          const isActiveCell = isActiveRow && column === assignCursorCol;
          const cellText = isChecked ? "[x]" : "[ ]";
          if (isActiveCell) {
            line += theme.fg("accent", theme.bold(` ${cellText}`));
          } else if (isChecked) {
            line += theme.fg("accent", ` ${cellText}`);
          } else {
            line += theme.fg("dim", ` ${cellText}`);
          }
        }
        line += rightMargin;
        lines.push(line);
      }

      if (assignRows.length > maxVisibleRows) {
        lines.push(theme.fg("dim", `${assignCursorRow + 1}/${assignRows.length} sounds`));
      }

      const currentHook = ASSIGN_SOUND_COLUMNS[assignCursorCol];
      const currentRow = assignRows[assignCursorRow];
      if (currentRow) {
        lines.push(theme.fg("muted", `Sound: ${currentRow.fileName}`));
      }
      if (currentHook) {
        lines.push(theme.fg("muted", `Hook: ${currentHook.key} — ${currentHook.description}`));
      }
      if (assignDirty) {
        lines.push(theme.fg("warning", "Unsaved assignment changes"));
      }

      return lines;
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
          lines.push(...formatDndStatus(currentConfig, currentMeetingActive, currentProcessActive).split("\n").map((line) => theme.fg("muted", line)));
        } else if (view === "test") {
          lines.push(theme.fg("accent", "Assign sounds to hooks"));
          lines.push(...renderAssignSoundGrid(width));
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
          const themeName = selectList?.getSelectedItem()?.value ?? String((selectList as any)?.items?.[themeIndex]?.value ?? "");
          if (themeName) {
            void playThemePreview(themeName, currentConfig.volume);
          }
          return;
        }

        if (view === "test") {
          if (kb.matches(data, "tui.select.cancel")) {
            void (async () => {
              if (await saveAssignChanges()) {
                view = "main";
                rebuildList();
                tui.requestRender();
              }
            })();
            return;
          }
          if (kb.matches(data, "tui.select.confirm")) {
            toggleAssignSound();
            return;
          }
          if (data === " ") {
            previewAssignSound();
            return;
          }
          if (isLeftInput(data, kb)) {
            assignCursorCol = Math.max(0, assignCursorCol - 1);
            tui.requestRender();
            return;
          }
          if (isRightInput(data, kb)) {
            assignCursorCol = Math.min(ASSIGN_SOUND_COLUMNS.length - 1, assignCursorCol + 1);
            tui.requestRender();
            return;
          }
          if (isUpInput(data, kb)) {
            assignCursorRow = Math.max(0, assignCursorRow - 1);
            tui.requestRender();
            return;
          }
          if (isDownInput(data, kb)) {
            assignCursorRow = Math.min(Math.max(0, assignRows.length - 1), assignCursorRow + 1);
            tui.requestRender();
            return;
          }
          if (data.toLowerCase() === "p") {
            previewAssignSound();
            return;
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
        const meetingActive = await isMeetingDndActive(config);
        const processActive = await isProcessDndActive(config);
        ctx.ui.notify(formatDndStatus(config, meetingActive, processActive), "info");
        return;
      }

      const config = await ensureConfig();
      const meetingActive = await isMeetingDndActive(config);
      const processActive = await isProcessDndActive(config);
      await showSoundsDashboard(ctx, config, meetingActive, processActive);
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
