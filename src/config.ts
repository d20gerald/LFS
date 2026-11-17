import "dotenv/config";

export interface Config {
  token: string;
  clientId: string;
  guildId: string | null;
  allowedChannelIds: Set<string>;
  lobbyTtlMs: number;
  dbPath: string;
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
  };
}
