/**
 * Pure lobby logic. No Discord, no database. Everything here is unit tested.
 */

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
export const MIN_JUICE = 0;
export const MAX_JUICE = 13;
export const MAX_SERVER_NAME_LENGTH = 32;
export const MAX_PASSWORD_LENGTH = 64;
export const MAX_NOTES_LENGTH = 200;

export type Vibe = "casual" | "tryhard";
export type LobbyStatus = "open" | "full" | "closed" | "expired";

export const VIBES: ReadonlyArray<{ value: Vibe; label: string }> = [
  { value: "casual", label: "🛋️ Casual" },
  { value: "tryhard", label: "🔥 Try-hard" },
];

/** Region choices, matching the Region picker on Sol Mates' Host screen. */
export const REGIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "usa-west", label: "USA, West" },
  { value: "usa-east", label: "USA, East" },
  { value: "south-america", label: "South America" },
  { value: "europe", label: "Europe" },
  { value: "asia", label: "Asia" },
  { value: "japan", label: "Japan" },
  { value: "south-korea", label: "South Korea" },
];

export interface Lobby {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;
  serverName: string;
  password: string | null;
  vibe: Vibe;
  seats: number;
  juice: number;
  region: string;
  notes: string | null;
  status: LobbyStatus;
  createdAt: number;
  expiresAt: number;
  closedAt: number | null;
  /** The crew's private voice channel, once one exists. */
  voiceChannelId: string | null;
  /** Discord user IDs in join order. The host is always first. */
  players: string[];
}

export interface LobbyInput {
  serverName: string;
  password?: string | null | undefined;
  vibe: Vibe;
  seats: number;
  juice: number;
  region: string;
  notes?: string | null | undefined;
}

export interface NormalizedLobbyInput {
  serverName: string;
  password: string | null;
  vibe: Vibe;
  seats: number;
  juice: number;
  region: string;
  notes: string | null;
}

export type ValidationResult =
  | { ok: true; value: NormalizedLobbyInput }
  | { ok: false; errors: string[] };

export function validateLobbyInput(input: LobbyInput): ValidationResult {
  const errors: string[] = [];
  const serverName = input.serverName.trim();
  if (serverName.length === 0) {
    errors.push("Server name is required. It is the name shown on the Host screen in Sol Mates.");
  } else if (serverName.length > MAX_SERVER_NAME_LENGTH) {
    errors.push(`Server name must be ${MAX_SERVER_NAME_LENGTH} characters or fewer.`);
  }

  const rawPassword = input.password?.trim() ?? "";
  if (rawPassword.length > MAX_PASSWORD_LENGTH) {
    errors.push(`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`);
  }

  if (!Number.isInteger(input.seats) || input.seats < MIN_SEATS || input.seats > MAX_SEATS) {
    errors.push(`Seats must be a whole number from ${MIN_SEATS} to ${MAX_SEATS}, host included.`);
  }

  if (!Number.isInteger(input.juice) || input.juice < MIN_JUICE || input.juice > MAX_JUICE) {
    errors.push(`Juice must be a whole number from ${MIN_JUICE} to ${MAX_JUICE}.`);
  }

  if (!VIBES.some((v) => v.value === input.vibe)) {
    errors.push("Vibe must be casual or tryhard.");
  }

  if (!REGIONS.some((r) => r.value === input.region)) {
    errors.push("Unknown region.");
  }

  const rawNotes = input.notes?.trim() ?? "";
  if (rawNotes.length > MAX_NOTES_LENGTH) {
    errors.push(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      serverName,
      password: rawPassword.length > 0 ? rawPassword : null,
      vibe: input.vibe,
      seats: input.seats,
      juice: input.juice,
      region: input.region,
      notes: rawNotes.length > 0 ? rawNotes : null,
    },
  };
}

export function isActive(lobby: Pick<Lobby, "status">): boolean {
  return lobby.status === "open" || lobby.status === "full";
}

export function openSeats(lobby: Pick<Lobby, "seats" | "players">): number {
  return Math.max(0, lobby.seats - lobby.players.length);
}

export function isExpired(lobby: Pick<Lobby, "expiresAt" | "status">, now: number): boolean {
  return isActive(lobby) && now >= lobby.expiresAt;
}

export function isMember(lobby: Pick<Lobby, "players">, userId: string): boolean {
  return lobby.players.includes(userId);
}

export type JoinResult =
  | { kind: "joined"; lobby: Lobby; nowFull: boolean }
  | { kind: "already-in" }
  | { kind: "full" }
  | { kind: "not-open" };

export function tryJoin(lobby: Lobby, userId: string): JoinResult {
  if (!isActive(lobby)) return { kind: "not-open" };
  if (isMember(lobby, userId)) return { kind: "already-in" };
  if (openSeats(lobby) === 0) return { kind: "full" };
  const players = [...lobby.players, userId];
  const nowFull = players.length >= lobby.seats;
  return {
    kind: "joined",
    nowFull,
    lobby: { ...lobby, players, status: nowFull ? "full" : "open" },
  };
}

export type LeaveResult =
  | { kind: "left"; lobby: Lobby }
  | { kind: "not-in" }
  | { kind: "host-cannot-leave" }
  | { kind: "not-open" };

export function tryLeave(lobby: Lobby, userId: string): LeaveResult {
  if (!isActive(lobby)) return { kind: "not-open" };
  if (!isMember(lobby, userId)) return { kind: "not-in" };
  if (lobby.hostId === userId) return { kind: "host-cannot-leave" };
  const players = lobby.players.filter((p) => p !== userId);
  return { kind: "left", lobby: { ...lobby, players, status: "open" } };
}

export function close(lobby: Lobby, now: number): Lobby {
  return { ...lobby, status: "closed", closedAt: now };
}

export function expire(lobby: Lobby, now: number): Lobby {
  return { ...lobby, status: "expired", closedAt: now };
}

export function vibeLabel(vibe: Vibe): string {
  return VIBES.find((v) => v.value === vibe)?.label ?? vibe;
}

export function regionLabel(region: string): string {
  return REGIONS.find((r) => r.value === region)?.label ?? region;
}

export function juiceLabel(juice: number): string {
  if (juice <= 0) return "🧃 No Juice";
  if (juice >= MAX_JUICE) return `🧃 Juice ${MAX_JUICE} (max, godspeed)`;
  return `🧃 Juice ${juice}/${MAX_JUICE}`;
}

/** Parse a button custom_id of the form `lfs:<action>:<lobbyId>`. */
export type ButtonAction = "join" | "leave" | "details" | "close";

export function buttonId(action: ButtonAction, lobbyId: number): string {
  return `lfs:${action}:${lobbyId}`;
}

export function parseButtonId(customId: string): { action: ButtonAction; lobbyId: number } | null {
  const match = /^lfs:(join|leave|details|close):(\d+)$/.exec(customId);
  if (!match) return null;
  return { action: match[1] as ButtonAction, lobbyId: Number(match[2]) };
}
