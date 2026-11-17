/**
 * Turns a Lobby into Discord embeds, buttons and text. Pure functions, unit tested.
 * The server name and password never appear in the public embed.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
} from "discord.js";
import {
  buttonId,
  isActive,
  juiceLabel,
  openSeats,
  regionLabel,
  vibeLabel,
  type Lobby,
} from "./lobby.js";

const COLOR_CASUAL = 0x3fb950;
const COLOR_TRYHARD = 0xf85149;
const COLOR_FULL = 0x58a6ff;
const COLOR_DONE = 0x6e7681;

export const EMBED_TITLE = "Looking for SolMates";

function mention(userId: string): string {
  return `<@${userId}>`;
}

function channelMention(channelId: string): string {
  return `<#${channelId}>`;
}

function discordRelative(unixMs: number): string {
  return `<t:${Math.floor(unixMs / 1000)}:R>`;
}

function statusLine(lobby: Lobby): string {
  switch (lobby.status) {
    case "open": {
      const seats = openSeats(lobby);
      const word = seats === 1 ? "seat" : "seats";
      return `🟢 **Open.** ${seats} ${word} left. Expires ${discordRelative(lobby.expiresAt)}.`;
    }
    case "full":
      return `🔵 **Crew complete.** The host has been pinged. Launch when ready! Expires ${discordRelative(lobby.expiresAt)}.`;
    case "closed":
      return "⚫ **Closed** by the host.";
    case "expired":
      return "⚫ **Expired.** Nobody launched in time. Post a new lobby to try again.";
  }
}

function color(lobby: Lobby): number {
  if (lobby.status === "full") return COLOR_FULL;
  if (!isActive(lobby)) return COLOR_DONE;
  return lobby.vibe === "tryhard" ? COLOR_TRYHARD : COLOR_CASUAL;
}

export function buildLobbyEmbed(lobby: Lobby): APIEmbed {
  const crew = lobby.players.map((id, i) => (i === 0 ? `${mention(id)} (host)` : mention(id)));
  const emptySeats = openSeats(lobby);
  for (let i = 0; i < emptySeats; i += 1) crew.push("_empty seat_");

  const embed = new EmbedBuilder()
    .setTitle(EMBED_TITLE)
    .setColor(color(lobby))
    .setDescription(
      [
        statusLine(lobby),
        "",
        isActive(lobby)
          ? "Hit **Join** to get the server name and password. Drop-in works even if the run is already underway."
          : "",
      ]
        .join("\n")
        .trim(),
    )
    .addFields(
      { name: "Vibe", value: vibeLabel(lobby.vibe), inline: true },
      { name: "Juice", value: juiceLabel(lobby.juice), inline: true },
      { name: "Region", value: regionLabel(lobby.region), inline: true },
      { name: `Crew (${lobby.players.length}/${lobby.seats})`, value: crew.join("\n") },
    )
    .setFooter({ text: `Lobby #${lobby.id} · LFS` })
    .setTimestamp(lobby.createdAt);

  if (lobby.notes) {
    embed.addFields({ name: "Notes from the host", value: lobby.notes });
  }

  if (isActive(lobby) && lobby.voiceChannelId) {
    embed.addFields({ name: "Voice chat", value: `${channelMention(lobby.voiceChannelId)} (crew only)` });
  }

  return embed.toJSON();
}

export function buildLobbyButtons(lobby: Lobby): ActionRowBuilder<ButtonBuilder>[] {
  const active = isActive(lobby);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buttonId("join", lobby.id))
      .setLabel("Join")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!active || openSeats(lobby) === 0),
    new ButtonBuilder()
      .setCustomId(buttonId("leave", lobby.id))
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(buttonId("details", lobby.id))
      .setLabel("Show server details")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(buttonId("close", lobby.id))
      .setLabel("Close (host)")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!active),
  );
  return [row];
}

/** The private text a crew member sees after joining. */
export function renderServerDetails(lobby: Lobby): string {
  const lines = [
    `**Server name:** \`${lobby.serverName}\``,
    lobby.password ? `**Password:** \`${lobby.password}\`` : "**Password:** none",
    "",
    "In Sol Mates: **Play → Join**, enter the name (and password), and you're aboard. You can drop in mid-mission.",
    `Host: ${mention(lobby.hostId)}. ${vibeLabel(lobby.vibe)} · ${juiceLabel(lobby.juice)} · ${regionLabel(lobby.region)}`,
    lobby.voiceChannelId ? `Voice chat: ${channelMention(lobby.voiceChannelId)} (crew only).` : "",
  ];
  return lines.filter((line, i) => line.length > 0 || i === 2).join("\n");
}

/** The public note when a crew's voice room opens (first crewmate aboard). */
export function renderVoiceRoomOpenedMessage(lobby: Lobby): { content: string; userIds: string[] } {
  const content = `${mention(lobby.hostId)} comms are open: ${channelMention(lobby.voiceChannelId ?? "")} is your crew's private voice room. It closes with the lobby.`;
  return { content, userIds: [lobby.hostId] };
}

/** The channel ping sent to the host when the last seat fills. */
export function renderCrewCompleteMessage(lobby: Lobby): { content: string; userIds: string[] } {
  const crew = lobby.players.slice(1).map(mention).join(", ");
  const voice = lobby.voiceChannelId ? ` Comms are open in ${channelMention(lobby.voiceChannelId)}.` : "";
  const content = `${mention(lobby.hostId)} your crew is complete: ${crew}. Everyone has the server details.${voice} Launch when ready! 🚀`;
  return { content, userIds: [...lobby.players] };
}

export function jumpLink(lobby: Lobby): string | null {
  if (!lobby.messageId) return null;
  return `https://discord.com/channels/${lobby.guildId}/${lobby.channelId}/${lobby.messageId}`;
}
