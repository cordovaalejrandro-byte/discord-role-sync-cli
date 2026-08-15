# Discord Reaction & Poll Role Sync

A one-shot command-line script that adds or removes a Discord role for everyone who reacted to a message or voted in its poll. It runs locally, makes the requested changes, prints a user-by-user audit log, and exits. It is not a continuously running bot.

## Features

- `ADD` and `REMOVE` actions.
- Supports all reactions on a message, one selected emoji, poll voters, or both.
- Accepts the required server, message, role, and action values through CLI flags or environment variables.
- Finds the message automatically across accessible text channels; an optional channel ID skips discovery.
- Idempotent: users who already have (or already lack) the role are logged and skipped.
- Excludes bots by default and de-duplicates users who reacted or voted more than once.
- Handles Discord pagination and rate-limit retries.
- Includes `--dry-run` for a safe preview.
- Uses only Node.js built-ins; there are no runtime dependencies.

## Requirements

- Node.js 20 or newer.
- A Discord application with a bot added to the target server.
- Bot permissions:
  - View Channels
  - Read Message History
  - Manage Roles
- Enable the **Message Content Intent** in the Discord Developer Portal when poll-voter support is needed; Discord can omit the `poll` field for apps without that intent.
- The bot's highest role must be above the role being assigned or removed.

Keep the bot token secret. Never commit `.env` or paste the token into screenshots or terminal recordings.

## Setup

1. Clone the repository and enter its directory.
2. Copy `.env.example` to `.env` if you want a reference file. Node.js 20.6+ can load it with `node --env-file=.env discord-role-sync.mjs --dry-run`; otherwise load the values into your shell. The script intentionally does not add a dotenv dependency.
3. Set the bot token and the four required IDs.

PowerShell example:

```powershell
$env:DISCORD_BOT_TOKEN = "your_bot_token"
$env:DISCORD_SERVER_ID = "123456789012345678"
$env:DISCORD_MESSAGE_ID = "123456789012345678"
$env:DISCORD_ROLE_ID = "123456789012345678"
$env:DISCORD_ACTION = "ADD"
node .\discord-role-sync.mjs --dry-run
```

macOS/Linux example:

```bash
export DISCORD_BOT_TOKEN="your_bot_token"
export DISCORD_SERVER_ID="123456789012345678"
export DISCORD_MESSAGE_ID="123456789012345678"
export DISCORD_ROLE_ID="123456789012345678"
export DISCORD_ACTION="ADD"
node ./discord-role-sync.mjs --dry-run
```

After reviewing the dry-run output, run the same command without `--dry-run`.

## CLI usage

```text
node discord-role-sync.mjs \
  --server-id SERVER_ID \
  --message-id MESSAGE_ID \
  --role-id ROLE_ID \
  --action ADD
```

The token can be supplied through `DISCORD_BOT_TOKEN` (recommended) or `--token`.

| Option | Environment variable | Description |
| --- | --- | --- |
| `--server-id` | `DISCORD_SERVER_ID` | Target Discord server/guild ID. |
| `--message-id` | `DISCORD_MESSAGE_ID` | Message containing reactions or a poll. |
| `--role-id` | `DISCORD_ROLE_ID` | Role to add or remove. |
| `--action` | `DISCORD_ACTION` | `ADD` or `REMOVE`. |
| `--channel-id` | `DISCORD_CHANNEL_ID` | Optional channel ID; avoids channel discovery. |
| `--source` | `DISCORD_SOURCE` | `auto` (default), `reactions`, or `poll`. |
| `--emoji` | `DISCORD_EMOJI` | Optional Unicode emoji or custom `name:id`. |
| `--dry-run` | — | Log proposed changes without modifying roles. |
| `--include-bots` | — | Include bot users; bots are excluded by default. |
| `--concurrency` | `DISCORD_CONCURRENCY` | Parallel member operations from 1–10; default is 3. |

Use `node discord-role-sync.mjs --help` for the built-in reference.

## How message discovery works

Discord's message endpoint requires both a channel ID and message ID, while the bounty's required inputs list only the server and message IDs. To bridge that gap, the script:

1. Fetches the server's accessible channels and active threads.
2. Checks text-capable channels until it finds the message.
3. Uses the optional `--channel-id` directly when supplied.

If the message is in an archived thread, supply its channel/thread ID explicitly.

## Reaction and poll behavior

With the default `--source auto`, the script collects:

- Users from every reaction shown on a normal message.
- Users who voted for any answer on a poll message.

The result is de-duplicated before role updates. Use `--source reactions`, `--source poll`, or `--emoji "✅"` when only one participation signal should count.

## Example output

```text
Locating message 123... in server 456...
Found message in #role-test (789...).
3 unique participant(s) found. Applying ADD...
ADDED Ada (111...) [reaction:✅]
UNCHANGED Lin (222...) — already has role [poll:1]
SKIPPED Sam (333...) — no longer a server member
Summary: {"found":3,"added":1,"removed":0,"unchanged":1,"skipped":1,"failed":0,"dryRun":false}
```

The process exits with code `1` if any member update fails, so it can be used safely in a local automation script.

## Demo checklist

1. Create a private test channel and a low-privilege test role.
2. Post a message and react from at least two test users, or create a poll and cast votes.
3. Run `ADD` and show the role appearing on the participating members.
4. Run `ADD` again to demonstrate idempotent `UNCHANGED` logging.
5. Run `REMOVE` and show the role being removed.
6. Keep the bot token and any `.env` file out of the recording.

## Troubleshooting

- **403 Missing Permissions:** grant the bot `Manage Roles` and move its bot role above the target role.
- **Message not found:** pass `--channel-id`, especially for archived threads.
- **No participants:** confirm the bot can view the message and that `--source`/`--emoji` matches it.
- **Poll is not detected:** enable Message Content Intent for the bot application, then rerun with `--source poll`.
- **Unknown member:** the user left the server; the script logs `SKIPPED` and continues.
- **Rate limited:** the script honors Discord's `retry_after` response and retries automatically.

## Tests

```bash
npm test
npm run check
```

The tests cover argument validation, reaction identifiers, reaction/poll de-duplication, idempotent role assignment, removal, and missing-member handling.

## License

MIT

## AI disclosure

This project was developed with AI-assisted coding using OpenAI Codex. Its test suite, documented setup, and verification steps are included so reviewers can evaluate the implementation directly. See [AI_DISCLOSURE.md](AI_DISCLOSURE.md).

