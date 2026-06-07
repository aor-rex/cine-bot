# cine

cine is a telegram media request bot.

it indexes files from telegram channels and groups, stores them in sqlite, and lets users search and receive files with telegram commands and inline buttons.

## features

- search movies and series with `/request <title>`
- index files from multiple saved source chats
- forward single files, episodes, seasons, or quality batches
- deduplicate files across multiple source chats
- live indexing for newly posted files
- historical backfill for old files with `gramjs`
- owner-only source management and backfill trigger
- optional required-channel join gate for dm access
- telegram command menu for users and owner/admin dm

## how it works

there are 2 indexing modes:

1. live indexing

- the bot is added to a source channel or group
- new files posted there are indexed automatically

2. historical backfill

- a telegram user session is used with `gramjs`
- old files from saved source chats are scanned and inserted into the database
- this is needed because bot api alone cannot reliably read files sent before the bot joined

## requirements

- node.js 18+
- npm
- a telegram bot token from botfather
- a telegram user account if you want to backfill old files

## installation

```bash
npm install
```

create a `.env` file:

```env
BOT_TOKEN=your_bot_token
OWNER_USER_ID=your_telegram_user_id
REQUIRED_CHANNEL_ID=
REQUIRED_CHANNEL_LINK=

# only needed for old-file backfill
API_ID=
API_HASH=
SESSION_STRING=
```

## setup

### 1. create the bot

- open `@botfather`
- create a bot
- copy the bot token into `BOT_TOKEN`

### 2. get your owner user id

- start the bot
- run `/myid`
- put that number into `OWNER_USER_ID`

### 3. start the bot

```bash
node src/index.js bot
```

or:

```bash
npm run start -- bot
```

## adding source chats

you can save source chats in 2 ways.

### option 1. auto-detect

- add the bot to a channel as admin
- or add the bot to a group/supergroup
- the bot will detect the chat and save it

### option 2. manual join

from the owner dm, use:

```text
/join -1001234567890
/join @channelusername
/join https://t.me/channelusername
```

then confirm saved sources with:

```text
/source
```

## how to use the bot

### for regular users

- `/start` - show the welcome message
- `/request <title>` - search for a movie or series
- `/cancel` - cancel the current action

if a required channel is configured, users must join it before they can use the bot in dm.

### for the owner

- `/myid` - show your Telegram user id
- `/source` - list saved source chats
- `/join <id/link>` - add a source chat manually
- `/required` - show the required channel gate
- `/setrequired <id> <link>` - set the required channel gate
- `/clearrequired` - clear the required channel gate
- `/initscan` - run historical backfill from owner DM

## required channel gate

you can require users to join a specific channel before they can use the bot in dm.

this gate:

- applies to regular users in dm
- does not block the owner
- does not affect group usage
- shows a `join channel` button and a `check again` button

you can configure it in 2 ways:

### option 1. from `.env`

```env
REQUIRED_CHANNEL_ID=-1001234567890
REQUIRED_CHANNEL_LINK=https://t.me/yourchannel
```

### option 2. from owner dm

```text
/setrequired -1001234567890 https://t.me/yourchannel
/required
/clearrequired
```

the bot should also be able to check membership in that channel, so make sure it has access there.

## request flow

typical flow:

1. user sends:

```text
/request life in pieces
```

2. bot shows matching titles
3. user chooses a title
4. bot shows seasons or versions
5. user chooses an episode, season batch, or version
6. bot forwards the file(s)

if search returns no exact result, the bot will try to suggest close matches.

## how to backfill old files

if you only care about new files, you can skip this section.

if you want files that were posted before the bot joined, you need:

- `API_ID`
- `API_HASH`
- `SESSION_STRING`

## how to get api id and api hash

these come from your telegram user account, not from botfather.

1. open `https://my.telegram.org`
2. log in with your phone number
3. open `api development tools`
4. create an app
5. copy your `api_id`
6. copy your `api_hash`
7. put them into `.env`

example:

```env
API_ID=12345678
API_HASH=your_api_hash_here
```

## how to get the session string

after `API_ID` and `API_HASH` are set, run:

```bash
npm run login
```

the script will prompt for:

- your phone number
- your telegram login code
- your 2fa password, if enabled

it will print:

```env
SESSION_STRING=...
```

copy that value into `.env`.

## ways to run init-scan

there are 2 ways.

### option 1. from the terminal

```bash
node src/index.js init-scan
```

### option 2. from the owner DM

send:

```text
/initscan
```

the bot will:

- verify that `API_ID`, `API_HASH`, and `SESSION_STRING` are set
- scan all saved source chats
- deduplicate repeated files
- reply with a summary when done

## what init-scan does

the scan:

- logs into Telegram with your user session
- reads all saved source chats from the database
- scans the full message history
- indexes files that are not already present
- skips duplicates across chats using the filename

## deployment

you can deploy this anywhere node.js can run.

common options:

- a vps
- a home server
- a cloud vm
- a systemd service on linux

### deployment command

start the bot with:

```bash
node src/index.js bot
```

or:

```bash
npm run start -- bot
```

### production notes

for production, make sure:

- `.env` is present on the server
- the bot is started with a process manager or system service
- the `data/` folder is stored on persistent storage

this matters because the sqlite database is stored at:

```text
data/cine.db
```

if `data/` is not on persistent storage, you can lose:

- indexed files
- source chat records
- search data

### recommended production setup

use a process manager or system service so the bot restarts automatically after reboot or failure.

examples:

- `systemd`
- `pm2`
- docker

### example systemd approach

run this command from the project directory:

```bash
node src/index.js bot
```

set the working directory to the project folder, make sure `.env` is present there, and keep the `data/` directory on persistent storage.

## database

the bot stores data in:

```text
data/cine.db
```

this includes:

- indexed files
- search data
- source chat list

## notes

- for channels, the bot should usually be an admin to receive posts reliably
- for groups/supergroups, the bot must be in the chat to index new files
- if you use the required-channel gate, the bot must be able to check membership in that channel
- old-file backfill needs your telegram user session, not just the bot token
- the bot supports multiple source chats
- duplicate files across sources are skipped during indexing

## useful commands

start bot:

```bash
node src/index.js bot
```

owner login helper:

```bash
npm run login
```

historical scan from terminal:

```bash
node src/index.js init-scan
```

## license

private project.
