# LFS (Looking For SolMates)

A Discord bot that helps players crew up for [Sol Mates](https://store.steampowered.com/app/2420800/Sol_Mates/), the co-op spaceship roguelike from Daruma Games. Think of it as the ship's intercom: the host posts a lobby, crewmates click Join, and everybody gets the server details without pasting them into public chat.

Inspired by [SpellBot](https://github.com/lexicalunit/spellbot), minus the Magic.

## How it works

1. In Sol Mates, choose **Play → Host**. Note the server name (the game randomizes one, like `OFFE`), set a password if you want one, and hit **Host**. You land at the Space Bar.
2. In Discord, run `/lobby` with that server name, your vibe (casual or try-hard), crew size (2 to 4, you included), Juice level (0 to 13) and region.
3. LFS posts an embed with **Join**, **Leave**, **Show server details** and **Close** buttons. The server name and password are hidden from the public post.
4. Crewmates click **Join** and receive the server name and password in a private reply only they can see.
5. When the last seat fills, LFS pings the host and crew in the channel. Sol Mates supports drop-in, so the host can start playing right away.
6. Lobbies the host does not close expire on their own (90 minutes by default).

`/lfs lobbies` lists the open lobbies on the server. `/lfs about` explains the bot.

One lobby per person at a time: you cannot host or join a second lobby until you leave or close the first.

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it LFS.
2. Under **Bot**, click **Reset Token** and copy the token. This is `DISCORD_TOKEN`. No privileged intents are needed.
3. Under **General Information**, copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
4. Under **OAuth2 → URL Generator**, tick the scopes `bot` and `applications.commands`, then the bot permissions **View Channels**, **Send Messages**, **Embed Links** and **Read Message History**. Open the generated URL and add the bot to the server. A server admin has to do this step.

Or use this URL with your application ID filled in:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=84992
```

### 2. Configure

```sh
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Setting `DISCORD_GUILD_ID` to the server's ID makes commands appear instantly instead of waiting up to an hour for global registration. `LFS_CHANNEL_IDS` restricts `/lobby` to specific channels.

### 3. Run locally

```sh
npm install
npm run register   # registers the slash commands with Discord
npm run dev        # starts the bot with live reload
```

Requires Node 22.13 or newer. The database is SQLite through Node's built-in `node:sqlite`, so there is nothing else to install.

### 4. Run in Docker

```sh
docker build -t lfs .
docker run -d --name lfs --env-file .env -v lfs-data:/data --restart unless-stopped lfs
```

Run `npm run register` once from any machine with the `.env` file before starting the container.

## Development

```sh
npm run check   # typecheck + tests
npm test        # tests only
npm run build   # compile to dist/
```

The lobby rules live in `src/lobby.ts` and the embed rendering in `src/render.ts`. Both are pure functions with unit tests. `src/handlers.ts` is the Discord glue. `src/db.ts` is the SQLite store.

## Known limits

- LFS cannot see inside the game. Seat counts are honor-system bookkeeping, and the Juice level is what the host declared, not what the Space Bar is set to.
- Anyone who joins can share the server details. A password is the only real lock, so LFS nudges hosts to set one.

## License

MIT

## Rollout plan

1. Install on the developer Discord first, with `DISCORD_GUILD_ID` set to that server so commands appear instantly, and `LFS_CHANNEL_IDS` pointing at a test channel.
2. Run a few real lobbies against the demo with volunteers. Fix the region list and any wording that does not match the game.
3. Install on the public Discord using the same install link. Add the crew-up channel's ID to `LFS_CHANNEL_IDS` (it accepts a comma-separated list, and channel IDs are unique across Discord) and clear `DISCORD_GUILD_ID` so commands register globally.

## Handing the bot to Daruma later

The Discord application can change hands without downtime. In the Developer Portal, the current owner creates a Team under **Teams**, invites a Daruma admin, then uses **Transfer App to Team** on the application. The bot token, server installs and slash commands all stay the same. The new owner then runs the container wherever they like with the same `.env` values.
