# Video demo plan

The final recording should be short, reproducible, and contain no credentials.

## Test-server setup

1. Create a private Discord server or private test channel.
2. Create a low-privilege role named `Reaction Tester`.
3. Place the bot's role above `Reaction Tester` and grant View Channels, Read Message History, and Manage Roles.
4. If demonstrating a poll, enable Message Content Intent for the bot application.
5. Post a message asking testers to react with ✅, then react from at least two test members.
6. Keep the bot token and `.env` file outside the recording frame.

## Recording sequence

1. Show the test message and the two reactions.
2. Show that neither participating member has `Reaction Tester`.
3. Run the command once with `--dry-run` and briefly show the `WOULD_ADDED` lines.
4. Run the `ADD` command and show the `ADDED` lines plus the summary.
5. Return to Discord and show the role on both members.
6. Run `ADD` again and show idempotent `UNCHANGED` output.
7. Run `REMOVE`, show the `REMOVED` lines, and confirm the role is absent in Discord.

If a poll is used instead, run with `--source poll` and show the voters before the command.

