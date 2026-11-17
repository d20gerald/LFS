/**
 * SQLite persistence via Node's built-in `node:sqlite`. No native build step.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Lobby, LobbyStatus, NormalizedLobbyInput } from "./lobby.js";

interface LobbyRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  host_id: string;
  server_name: string;
  password: string | null;
  vibe: string;
  seats: number;
  juice: number;
  region: string;
  notes: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lobbies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  host_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  password TEXT,
  vibe TEXT NOT NULL,
  seats INTEGER NOT NULL,
  juice INTEGER NOT NULL,
  region TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lobbies_status ON lobbies(status);
CREATE INDEX IF NOT EXISTS idx_lobbies_guild ON lobbies(guild_id, status);

CREATE TABLE IF NOT EXISTS lobby_players (
  lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (lobby_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lobby_players_user ON lobby_players(user_id);
`;

export class LobbyStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createLobby(args: {
    guildId: string;
    channelId: string;
    hostId: string;
    input: NormalizedLobbyInput;
    now: number;
    ttlMs: number;
  }): Lobby {
    const { guildId, channelId, hostId, input, now, ttlMs } = args;
    const result = this.db
      .prepare(
        `INSERT INTO lobbies (guild_id, channel_id, host_id, server_name, password, vibe, seats, juice, region, notes, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        guildId,
        channelId,
        hostId,
        input.serverName,
        input.password,
        input.vibe,
        input.seats,
        input.juice,
        input.region,
        input.notes,
        now,
        now + ttlMs,
      );
    const id = Number(result.lastInsertRowid);
    this.db
      .prepare("INSERT INTO lobby_players (lobby_id, user_id, position, joined_at) VALUES (?, ?, 0, ?)")
      .run(id, hostId, now);
    const lobby = this.getLobby(id);
    if (!lobby) throw new Error(`Lobby ${id} vanished right after insert`);
    return lobby;
  }

  getLobby(id: number): Lobby | null {
    const row = this.db.prepare("SELECT * FROM lobbies WHERE id = ?").get(id) as LobbyRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** The open or full lobby this user is hosting or has joined in this guild, if any. */
  findActiveLobbyForUser(guildId: string, userId: string): Lobby | null {
    const row = this.db
      .prepare(
        `SELECT l.* FROM lobbies l
         JOIN lobby_players p ON p.lobby_id = l.id
         WHERE l.guild_id = ? AND p.user_id = ? AND l.status IN ('open', 'full')
         ORDER BY l.created_at DESC LIMIT 1`,
      )
      .get(guildId, userId) as LobbyRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  setMessageId(id: number, messageId: string): void {
    this.db.prepare("UPDATE lobbies SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  /** Persist player list and status from an updated Lobby value. */
  savePlayersAndStatus(lobby: Lobby, now: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM lobby_players WHERE lobby_id = ?").run(lobby.id);
      const insert = this.db.prepare(
        "INSERT INTO lobby_players (lobby_id, user_id, position, joined_at) VALUES (?, ?, ?, ?)",
      );
      lobby.players.forEach((userId, position) => insert.run(lobby.id, userId, position, now));
      this.db
        .prepare("UPDATE lobbies SET status = ?, closed_at = ? WHERE id = ?")
        .run(lobby.status, lobby.closedAt, lobby.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setStatus(id: number, status: LobbyStatus, closedAt: number | null): void {
    this.db.prepare("UPDATE lobbies SET status = ?, closed_at = ? WHERE id = ?").run(status, closedAt, id);
  }

  /** Active lobbies whose expiry time has passed. */
  listExpired(now: number): Lobby[] {
    const rows = this.db
      .prepare("SELECT * FROM lobbies WHERE status IN ('open', 'full') AND expires_at <= ? ORDER BY id")
      .all(now) as unknown as LobbyRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listActive(guildId?: string): Lobby[] {
    const rows = (
      guildId
        ? this.db
            .prepare("SELECT * FROM lobbies WHERE guild_id = ? AND status IN ('open', 'full') ORDER BY id")
            .all(guildId)
        : this.db.prepare("SELECT * FROM lobbies WHERE status IN ('open', 'full') ORDER BY id").all()
    ) as unknown as LobbyRow[];
    return rows.map((row) => this.hydrate(row));
  }

  private hydrate(row: LobbyRow): Lobby {
    const players = (
      this.db
        .prepare("SELECT user_id FROM lobby_players WHERE lobby_id = ? ORDER BY position")
        .all(row.id) as unknown as Array<{ user_id: string }>
    ).map((p) => p.user_id);
    return {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      hostId: row.host_id,
      serverName: row.server_name,
      password: row.password,
      vibe: row.vibe as Lobby["vibe"],
      seats: row.seats,
      juice: row.juice,
      region: row.region,
      notes: row.notes,
      status: row.status as LobbyStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      closedAt: row.closed_at,
      players,
    };
  }
}
