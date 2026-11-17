import "dotenv/config";

export interface Config {
  token: string;
  clientId: string;
  guildId: string | null;
  allowedChannelIds: Set<string>;
  lobbyTtlMs: number;
  dbPath: string;
  /** Create a private voice channel per crew. Needs Manage Channels and Manage Roles. */
  voiceRooms: boolean;
  /** Category ID voice rooms are created under. Null = find or create one by name. */
  voiceCategoryId: string | null;
  /** Category name used when no ID is configured. */
  voiceCategoryName: string;
}

export const DEFAULT_VOICE_CATEGORY_NAME = "LFS Voice";

function flag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  throw new Error(`Expected on/off, got "${value}".`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ttlMinutes = Number(env.LFS_LOBBY_TTL_MINUTES ?? "90");
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new Error("LFS_LOBBY_TTL_MINUTES must be a positive number.");
  }
  const channels = (env.LFS_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    guildId: env.DISCORD_GUILD_ID?.trim() || null,
    allowedChannelIds: new Set(channels),
    lobbyTtlMs: ttlMinutes * 60_000,
    dbPath: env.LFS_DB_PATH?.trim() || "./data/lfs.sqlite",
    voiceRooms: flag(env.LFS_VOICE_ROOMS, true),
    voiceCategoryId: env.LFS_VOICE_CATEGORY_ID?.trim() || null,
    voiceCategoryName: env.LFS_VOICE_CATEGORY_NAME?.trim() || DEFAULT_VOICE_CATEGORY_NAME,
  };
}
