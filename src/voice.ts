/**
 * Crew voice rooms. Discord glue for creating, updating and tearing down a private
 * voice channel per lobby. Every function here tolerates missing permissions and
 * deleted channels: a lobby must keep working even when voice rooms cannot.
 */
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type OverwriteResolvable,
} from "discord.js";
import type { Config } from "./config.js";
import type { Lobby } from "./lobby.js";

export interface VoiceContext {
  client: Client;
  config: Config;
}

/** Guild-level permissions the bot needs before it can run crew voice rooms at all. */
export const VOICE_ROOM_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
] as const;

export function voiceRoomName(lobby: Pick<Lobby, "id">): string {
  return `LFS Crew #${lobby.id}`;
}

/** Overwrites that hide the room from the server and admit only the crew (and the bot). */
export function crewOverwrites(guild: Pick<Guild, "id">, lobby: Pick<Lobby, "players">, botUserId: string): OverwriteResolvable[] {
  const crewAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.Stream,
    PermissionFlagsBits.UseVAD,
  ];
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    {
      id: botUserId,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels],
    },
    ...lobby.players.map((id) => ({ id, type: OverwriteType.Member, allow: crewAllow })),
  ];
}

function warn(lobby: Pick<Lobby, "id">, what: string, error: unknown): void {
  console.warn(`Voice room for lobby #${lobby.id}: ${what}:`, (error as Error)?.message ?? error);
}

async function botCanRunVoiceRooms(guild: Guild): Promise<{ ok: true; botUserId: string } | { ok: false; missing: string[] }> {
  const me = await guild.members.fetchMe();
  const missing = VOICE_ROOM_PERMISSIONS.filter((p) => !me.permissions.has(p)).map((p) => {
    const name = Object.entries(PermissionFlagsBits).find(([, v]) => v === p)?.[0];
    return name ?? String(p);
  });
  return missing.length === 0 ? { ok: true, botUserId: me.id } : { ok: false, missing };
}

/**
 * The category voice rooms live under. Uses LFS_VOICE_CATEGORY_ID when set, otherwise finds a
 * category named like the configured default and creates it if the server has none.
 */
async function resolveCategory(guild: Guild, config: Config): Promise<string | null> {
  if (config.voiceCategoryId) {
    const channel = await guild.channels.fetch(config.voiceCategoryId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildCategory) return channel.id;
    console.warn(
      `LFS_VOICE_CATEGORY_ID ${config.voiceCategoryId} is not a category in guild ${guild.id}. Falling back to "${config.voiceCategoryName}".`,
    );
  }
  const wanted = config.voiceCategoryName.toLowerCase();
  const all = await guild.channels.fetch();
  const existing = [...all.values()].find(
    (c) => c !== null && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === wanted,
  );
  if (existing) return existing.id;
  const created = await guild.channels.create({
    name: config.voiceCategoryName,
    type: ChannelType.GuildCategory,
    reason: "LFS crew voice rooms",
  });
  return created.id;
}

/** Create the crew's private voice room. Returns its channel ID, or null when it could not be made. */
export async function createVoiceRoom(ctx: VoiceContext, lobby: Lobby): Promise<string | null> {
  if (!ctx.config.voiceRooms) return null;
  try {
    const guild = await ctx.client.guilds.fetch(lobby.guildId);
    const check = await botCanRunVoiceRooms(guild);
    if (!check.ok) {
      console.warn(
        `Voice room for lobby #${lobby.id}: skipped, bot is missing ${check.missing.join(", ")} in guild ${guild.id}. Re-invite with the install link in the README.`,
      );
      return null;
    }
    const parent = await resolveCategory(guild, ctx.config);
    const channel = await guild.channels.create({
      name: voiceRoomName(lobby),
      type: ChannelType.GuildVoice,
      parent,
      userLimit: lobby.seats,
      permissionOverwrites: crewOverwrites(guild, lobby, check.botUserId),
      reason: `LFS lobby #${lobby.id} crew voice`,
    });
    return channel.id;
  } catch (error) {
    warn(lobby, "could not create", error);
    return null;
  }
}

/**
 * Bring the room's member list in line with the lobby's crew. Returns false when the room is
 * gone (someone deleted it by hand), so the caller can forget its ID or make a new one.
 */
export async function syncVoiceRoom(ctx: VoiceContext, lobby: Lobby): Promise<boolean> {
  if (!lobby.voiceChannelId) return false;
  try {
    const guild = await ctx.client.guilds.fetch(lobby.guildId);
    const channel = await guild.channels.fetch(lobby.voiceChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) return false;
    const me = await guild.members.fetchMe();
    await channel.permissionOverwrites.set(crewOverwrites(guild, lobby, me.id), `LFS lobby #${lobby.id} crew changed`);
    return true;
  } catch (error) {
    warn(lobby, "could not update members", error);
    // The room exists as far as we know; keep its ID rather than orphaning it.
    return true;
  }
}

/** Delete the crew's voice room. Quiet if it is already gone. */
export async function deleteVoiceRoom(ctx: VoiceContext, lobby: Lobby): Promise<void> {
  if (!lobby.voiceChannelId) return;
  try {
    const guild = await ctx.client.guilds.fetch(lobby.guildId);
    const channel = await guild.channels.fetch(lobby.voiceChannelId).catch(() => null);
    if (!channel) return;
    await channel.delete(`LFS lobby #${lobby.id} ${lobby.status}`);
  } catch (error) {
    warn(lobby, "could not delete", error);
  }
}
