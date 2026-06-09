import { APIGatewayProxyResult } from "aws-lambda";
import {
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  ssmClient,
  withRetry,
  SSM_PARAMS,
} from "../utils/aws-clients";
import { InteractionResponseType } from "./types";
import { persona, personaEmbed } from "./util/persona";

// NOTE: all work happens INLINE before returning. Lambda freezes the execution
// environment the moment the handler returns, so a fire-and-forget deferred
// pattern silently never runs (that bug shipped in v1's first deploy). The few
// calls here — one SSM read, one Discord webhook create, one SSM write, one
// webhook test post — fit comfortably inside Discord's 3-second response window.

const respond = (data: Record<string, unknown>): APIGatewayProxyResult => ({
  statusCode: 200,
  body: JSON.stringify({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  }),
});

export async function handleSetupCommand(interaction: any): Promise<APIGatewayProxyResult> {
  const { guild_id, channel_id, member } = interaction;

  // Check if user has permissions (manage webhooks)
  const permissions = BigInt(member.permissions);
  const MANAGE_WEBHOOKS = BigInt(1 << 29);

  if (!(permissions & MANAGE_WEBHOOKS)) {
    return respond({
      content: '❌ You need "Manage Webhooks" permission to use this command.',
      flags: 64, // Ephemeral
    });
  }

  try {
    // Check if a webhook already exists for this guild
    const existingWebhookParam = `${SSM_PARAMS.DISCORD_WEBHOOK}/${guild_id}`;
    let existingWebhook: string | undefined;

    try {
      const result = await withRetry(() => ssmClient.send(new GetParameterCommand({
        Name: existingWebhookParam,
        WithDecryption: true
      })));
      existingWebhook = result.Parameter?.Value;
    } catch (err) {
      // No existing webhook, which is fine
      console.log('No existing webhook found for guild:', guild_id);
    }

    if (existingWebhook) {
      // Test if the existing webhook still works
      try {
        const testResponse = await fetch(existingWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: '✅ Webhook is already configured and working!',
            username: persona.characterName,
          }),
        });

        if (testResponse.ok) {
          return respond({
            embeds: [personaEmbed({
              title: '📢 Notifications Active',
              description: `${persona.botName} is already set up to send notifications in this server.`,
              extra: {
                fields: [{
                  name: 'Need to change channels?',
                  value: 'Delete the webhook in this channel\'s settings and run `/gate setup` in the new channel.',
                  inline: false
                }],
              },
            })],
          });
        }
      } catch (err) {
        console.log('Existing webhook is no longer valid, creating new one');
      }
    }

    // Create a new webhook using Discord's API
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      console.error('DISCORD_BOT_TOKEN not configured');
      return respond({
        content: '❌ Bot configuration error: Missing bot token. Please contact the administrator.',
        flags: 64,
      });
    }

    console.log('Creating webhook for channel:', channel_id);
    const createResponse = await fetch(`https://discord.com/api/v10/channels/${channel_id}/webhooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `${persona.botName} Notifications`,
        avatar: null,
      }),
    });

    if (!createResponse.ok) {
      const errorData: any = await createResponse.json().catch(() => ({}));
      console.error('Failed to create webhook:', createResponse.status, errorData);

      if (createResponse.status === 403) {
        return respond({
          content: '❌ I don\'t have permission to create webhooks in this channel. Please ensure I have the "Manage Webhooks" permission.',
          flags: 64,
        });
      }
      throw new Error(`Failed to create webhook: ${errorData.message || `HTTP ${createResponse.status}`}`);
    }

    const webhookData: any = await createResponse.json();
    const webhookUrl = `https://discord.com/api/webhooks/${webhookData.id}/${webhookData.token}`;
    console.log('Webhook created successfully:', webhookData.id);

    // Store the webhook URL in SSM
    await withRetry(() => ssmClient.send(new PutParameterCommand({
      Name: existingWebhookParam,
      Value: webhookUrl,
      Type: 'String',
      Overwrite: true,
      Description: `Discord webhook for guild ${guild_id} in channel ${channel_id}`,
    })));

    // Send a test message through the webhook (proves the notification path live)
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: persona.characterName,
        ...(persona.thumbnailUrl ? { avatar_url: persona.thumbnailUrl } : {}),
        embeds: [personaEmbed({
          title: '🎉 Webhook Created Successfully!',
          description: 'I\'ll send server notifications to this channel.',
          extra: {
            fields: [
              {
                name: '📬 Notifications You\'ll Receive',
                value: '• Server online — with the join address\n• Idle / shutdown notices\n• Backup status updates',
                inline: false
              },
              {
                name: '🛠️ Next Steps',
                value: 'Use `/gate start` to launch the server and you\'ll see notifications here!',
                inline: false
              }
            ],
            timestamp: new Date().toISOString(),
          },
        })]
      }),
    });

    return respond({
      embeds: [personaEmbed({
        title: '✨ Notifications Configured',
        description: `${persona.botName} will now send server updates to this channel.`,
      })],
    });

  } catch (error) {
    console.error('Error in setup command:', error);
    return respond({
      embeds: [personaEmbed({
        title: '⚠️ Setup Failed',
        description: `Error: ${error instanceof Error ? error.message : String(error)}`,
        color: 0xff0000,
        footerSuffix: 'Contact support if this persists',
        extra: {
          fields: [{
            name: 'Manual Setup',
            value: '1. Go to Channel Settings → Integrations → Webhooks\n2. Create a new webhook\n3. Contact your administrator to configure it',
            inline: false
          }],
        },
      })],
      flags: 64, // Ephemeral for error messages
    });
  }
}
