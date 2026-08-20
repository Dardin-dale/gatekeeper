# Discord Integration Setup Guide

This guide walks you through setting up Discord integration for GATEKeeper. You'll need three pieces of information from Discord's Developer Portal: **Application ID**, **Public Key**, and **Bot Token**.

> **One app per game.** Each deployed game stack is its own Discord application (its own bot, icon
> and `/command`). Create a **new** application here — don't reuse another bot's credentials. The
> values can go in `.env` or in the gitignored `config/<game>.discord.json`
> (`{ "appId", "publicKey", "botToken" }`).

## Prerequisites

- A Discord account
- Administrator permissions on the Discord server where you want to use GATEKeeper
- 10-15 minutes to complete setup

## Step 1: Create a Discord Application

1. **Open Discord Developer Portal**
   - Go to: https://discord.com/developers/applications
   - Click the "New Application" button (top right)

2. **Name Your Application**
   - Enter a name (e.g., "GATEKeeper" for Abiotic Factor)
   - Accept the Terms of Service
   - Click "Create"

## Step 2: Get Your Application ID and Public Key

You'll now see your application's settings page.

### Application ID
1. Look at the "APPLICATION ID" section near the top of the page
2. Click the "Copy" button to copy your Application ID
3. **Save this value** - you'll need it for your `.env` file as `DISCORD_APP_ID`

**Example:** `1234567890123456789` (18-19 digit number)

### Public Key
1. Scroll down slightly to find "PUBLIC KEY"
2. Click the "Copy" button to copy your Public Key
3. **Save this value** - you'll need it for your `.env` file as `DISCORD_BOT_PUBLIC_KEY`

**Example:** `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6` (64 character hex string)

## Step 3: Create a Bot User

1. **Navigate to the Bot Section**
   - Click "Bot" in the left sidebar
   - Click "Add Bot"
   - Confirm by clicking "Yes, do it!"

2. **Configure Bot Settings**
   - **Bot Name**: Change if desired (this is what users see)
   - **Bot Icon**: Upload an icon if you want (optional)

3. **Disable Public Bot** (Recommended)
   - Uncheck "Public Bot" to prevent others from adding your bot to their servers

4. **Enable Privileged Gateway Intents** (Not required for basic functionality)
   - Leave these all OFF
   - GATEKeeper is an HTTP-interactions bot and doesn't need privileged intents

## Step 4: Get Your Bot Token

**⚠️ IMPORTANT: Keep this token SECRET! Never share it or commit it to Git.**

1. **Reset and Copy Token**
   - Under "TOKEN" section, click "Reset Token"
   - Click "Yes, do it!" to confirm
   - Click "Copy" to copy the new token
   - **Save this immediately** - you won't be able to see it again!

2. **Save to .env File**
   - Add this as `DISCORD_BOT_SECRET_TOKEN` in your `.env` file
   - **Example format:** `NzkyNzE1...` (a long string with dots)

**Security Notes:**
- If you lose this token, just reset it and update your `.env` file
- Never commit `.env` to version control
- If the token is leaked, reset it immediately in the Developer Portal

## Step 5: Configure Bot Permissions

1. **Navigate to OAuth2 > URL Generator**
   - Click "OAuth2" in left sidebar
   - Click "URL Generator"

2. **Select Scopes**
   Check these boxes:
   - ✅ `bot` - Allows your bot to join servers
   - ✅ `applications.commands` - Enables slash commands

3. **Select Bot Permissions**
   Scroll down and check these permissions:
   - ✅ `View Channel` - See the channel the status message lives in
   - ✅ `Send Messages` - Fallback posts (persona posts go through the webhook)
   - ✅ `Manage Messages` - **Pin** the durable status message (see below)
   - ✅ `Embed Links` - Rich embeds
   - ✅ `Read Message History` - Required alongside `Manage Messages` to pin
   - ✅ `Manage Webhooks` - Required for the `/<cmd> setup` command

4. **Copy the Generated URL**
   - At the bottom, you'll see a "Generated URL"
   - Click "Copy" to copy this URL
   - **Keep this URL** - you'll use it to add the bot to your server

> **Shortcut — let the CLI build it.** Rather than clicking through the generator
> (and risking a mismatched permission set), print the exact URL for the active
> game, with the permission integer derived from named flags:
>
> ```bash
> npm run cli discord invite-url            # active GAME
> GAME=valheim npm run cli discord invite-url
> ```
>
> Each game is a separate Discord application with its own id, so the URL is
> per-game and is generated from *your* `config/<game>.discord.json` (or `.env`).
> Never reuse someone else's invite link — it would add THEIR bot, not yours.

## Step 6: Add Bot to Your Discord Server

1. **Open the Invite URL**
   - Paste the URL you copied into your browser

2. **Select Your Server**
   - Choose the Discord server where you want to add the bot
   - Click "Continue"

3. **Authorize Permissions**
   - Review the permissions (should match what you selected)
   - Click "Authorize"
   - Complete any CAPTCHA if prompted

4. **Verify Bot Joined**
   - Check your Discord server's member list
   - You should see your bot (it will appear offline — that's normal for HTTP-interactions bots)

## Updating Permissions Later

Discord has **no mechanism for a bot to request additional permissions** at
runtime — a bot cannot prompt you, and there is no in-app upgrade flow. The only
way to widen an already-installed bot's permissions is to re-run the OAuth2
authorization with a larger `permissions` integer, which updates the bot's
managed role in that guild.

```bash
npm run cli discord invite-url    # same link as a first install
```

Open it, pick the server the bot is **already** in, and Authorize. This is
non-destructive: the bot is not kicked, its token is unchanged, and registered
slash commands are untouched.

> ⚠️ **Channel overwrites beat role permissions.** Discord resolves channel-level
> overwrites *after* server-level roles, so a channel that explicitly denies a
> permission (directly on the bot's role, or inherited from an `@everyone` deny)
> wins over anything the invite link grants. If a permission still doesn't work
> after re-authorizing, fix it on the channel: right-click the channel → **Edit
> Channel** → **Permissions**.

### Why `Manage Messages`

GATEKeeper keeps **one durable status message per Discord server**: created and
pinned once, then edited in place for every session afterwards (Starting →
Online → Offline). That's why the bot needs `Manage Messages` — and why it needs
a bot token at all for this. Webhooks post the message but **cannot pin it**; a
webhook has no identity to act as, so the pin call uses the bot.

Pinning is best-effort. Without the permission the host logs

```
WARNING: pin refused (403) — the bot needs Manage Messages in channel <id>
```

and everything else still works — the status message posts and updates normally,
it just isn't pinned. Grant the permission and it pins on the next session.

## Step 7: Deploy GATEKeeper Infrastructure

Before Discord commands will work, you need to deploy GATEKeeper to AWS:

```bash
# Make sure .env is configured with Discord credentials
source .env

# Deploy to AWS (takes 10-15 minutes)
npm run deploy
```

After deployment completes, you'll see an **API Gateway endpoint URL**. Keep this for the next step!

**Example output:**
```
Outputs:
GateStack-AbioticFactor.ApiEndpoint = https://abc123xyz.execute-api.us-west-2.amazonaws.com/prod/
```

## Step 8: Set Interactions Endpoint URL

This is the crucial step that connects Discord to your deployed Lambda functions.

1. **Go Back to Discord Developer Portal**
   - Navigate to your application: https://discord.com/developers/applications
   - Select your GATEKeeper application

2. **Navigate to General Information**
   - Click "General Information" in the left sidebar
   - Scroll down to "INTERACTIONS ENDPOINT URL"

3. **Enter Your Endpoint URL**
   - Take your API Gateway URL from deployment
   - Add `interactions/control` to the end
   - **Example:** `https://abc123xyz.execute-api.us-west-2.amazonaws.com/prod/interactions/control`
   - Paste this into the "INTERACTIONS ENDPOINT URL" field
   - Click "Save Changes"

4. **Discord Verification**
   - Discord will automatically send a test request to verify the endpoint
   - If valid, you'll see a green checkmark
   - If it fails, double-check:
     - URL is exactly correct (no trailing slash, includes `/interactions/control`)
     - Your deployment succeeded
     - Your Lambda function is running
     - Your `DISCORD_BOT_PUBLIC_KEY` in `.env` matches the one in Developer Portal

## Step 9: Initialize in Discord Server

Almost done! Now set up notifications in your Discord channel:

1. **Go to Your Discord Server**
   - Open the channel where you want server notifications

2. **Run the Setup Command**
   ```
   /gate setup
   ```
   - This creates a webhook for server notifications
   - The webhook URL is stored encrypted in SSM Parameter Store

3. **Verify Setup**
   - You should see a success message
   - The bot will use this channel for server status updates

## Step 10: Test Your Bot

Try these commands to verify everything works:

```
/gate hail         # Persona ping — works with no server running
/gate help         # Shows available commands
/gate status       # Checks server status
```

If you see responses, congratulations! Your Discord integration is working!

## Common Issues and Solutions

### "Application did not respond" Error

**Cause:** Discord can't reach your Interactions Endpoint URL

**Solutions:**
1. Verify the endpoint URL is correct in Developer Portal
2. Check that your Lambda function deployed successfully
3. Verify `DISCORD_BOT_PUBLIC_KEY` matches in both `.env` and Developer Portal
4. Check CloudWatch Logs for your Lambda function for errors

### Bot Appears Offline

**This is normal!** Discord bots using slash commands don't need to maintain a gateway connection, so they appear offline. The bot will still respond to slash commands.

### Commands Don't Appear

**Cause:** Slash commands weren't registered

**Solution:**
```bash
npm run register-commands
```

Note: globally-registered commands can take up to ~1 hour to appear the first time.

### Webhook Not Working

**Cause:** The `/gate setup` command may not have completed successfully

**Solutions:**
1. Run `/gate setup` again in your desired channel
2. Check CloudWatch Logs for webhook creation errors
3. Verify the bot has "Manage Webhooks" permission in that channel

## Getting Your Discord Server ID

World configuration ties each world to a Discord server ID:

1. **Enable Developer Mode in Discord**
   - User Settings → Advanced → Enable "Developer Mode"

2. **Copy Server ID**
   - Right-click your server icon in the left sidebar
   - Click "Copy Server ID"
   - Paste this as `discordServerId` in your world's entry in `config/<game>.worlds.json`

## Security Best Practices

- ✅ Never share your Bot Token with anyone
- ✅ Keep your `.env` file out of version control (add to `.gitignore`)
- ✅ If you suspect your token was compromised, reset it immediately in Developer Portal
- ✅ Disable "Public Bot" to prevent unauthorized installations
- ✅ Only grant the minimum required permissions
- ✅ Use Discord's audit log to monitor bot actions

## Next Steps

Now that Discord is set up:

1. Configure your first world in `config/<game>.worlds.json`
2. Use `/gate start` to launch the server
3. Invite friends and share the join address (posted in Discord when the server is live)
4. Use `/gate stop` when done playing to save on AWS costs (idle auto-shutdown has your back regardless)

## Additional Resources

- [Discord Developer Documentation](https://discord.com/developers/docs)

## Need Help?

- Check the [GATEKeeper README](../README.md)
- Review [CloudWatch Logs](https://console.aws.amazon.com/cloudwatch/home#logs:) for errors
- Create an issue on GitHub