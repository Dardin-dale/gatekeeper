import type { EventBridgeEvent, Context } from 'aws-lambda';

// Mock SSM Client - store the send mock in global
jest.mock('@aws-sdk/client-ssm', () => {
  const mockSend = jest.fn();
  (global as any).__mockSsmSend = mockSend;

  return {
    SSMClient: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    GetParameterCommand: jest.fn().mockImplementation((input: any) => ({
      input,
      constructor: { name: 'GetParameterCommand' },
    })),
    PutParameterCommand: jest.fn().mockImplementation((input: any) => ({
      input,
      constructor: { name: 'PutParameterCommand' },
    })),
  };
});

// Mock the EventBridge Scheduler client used for TTL message deletion.
jest.mock('@aws-sdk/client-scheduler', () => {
  const mockSend = jest.fn();
  (global as any).__mockSchedulerSend = mockSend;
  return {
    SchedulerClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateScheduleCommand: jest.fn().mockImplementation((input: any) => ({ input })),
  };
});

// Mock global fetch - store in global for test access
const mockFetch = jest.fn();
(global as any).__mockFetch = mockFetch;
global.fetch = mockFetch as any;

// Get references to the actual mocks
const getMockSsmSend = () => (global as any).__mockSsmSend as jest.Mock;
const getMockFetch = () => (global as any).__mockFetch as jest.Mock;
const getMockSchedulerSend = () => (global as any).__mockSchedulerSend as jest.Mock;

// Scheduler env is read at module load — set it BEFORE importing the handler.
process.env.SCHEDULER_GROUP = 'gatekeeper-abiotic-factor';
process.env.SCHEDULER_TARGET_ARN = 'arn:aws:lambda:us-west-2:123:function:scheduler';
process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123:role/sched';

// Import after mocking
import { handler } from '../../lib/lambdas/discord-notifications';

/**
 * The on-host monitor posts readiness + idle/backup messages directly to the
 * webhook, so the Lambda is responsible for ONE event: the final EC2 "stopped"
 * confirmation. Anything else is ignored.
 */
describe('Discord Notifications Lambda', () => {
  const mockContext = {
    callbackWaitsForEmptyEventLoop: true,
    functionName: 'test',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-west-2:123456789012:function:test',
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'test-stream',
    getRemainingTimeInMillis: () => 30000,
    done: jest.fn(),
    fail: jest.fn(),
    succeed: jest.fn(),
  } as Context;

  const getFetchBody = (callIndex = 0): any => {
    const call = getMockFetch().mock.calls[callIndex];
    return JSON.parse(call[1].body);
  };

  const setupWebhookMock = () => {
    getMockSsmSend().mockImplementation((command: any) => {
      const name = command.input?.Name;
      if (name === '/gatekeeper/abiotic-factor/active-world') {
        return Promise.resolve({
          Parameter: {
            Value: JSON.stringify({
              name: 'TestWorld',
              discordServerId: 'test-guild-123',
              serverPassword: 'secret123',
            }),
          },
        });
      }
      if (name === '/gatekeeper/abiotic-factor/discord-webhook/test-guild-123') {
        return Promise.resolve({
          Parameter: { Value: 'https://discord.com/api/webhooks/123/abc' },
        });
      }
      const error = new Error('Parameter not found');
      (error as any).name = 'ParameterNotFound';
      return Promise.reject(error);
    });
  };

  beforeEach(() => {
    getMockSsmSend().mockReset();
    getMockFetch().mockReset();
    getMockSchedulerSend().mockReset();
    getMockSchedulerSend().mockResolvedValue({});
    getMockFetch().mockResolvedValue({ ok: true, status: 204 });
    getMockSsmSend().mockRejectedValue({ name: 'ParameterNotFound' });
  });

  const stoppedEvent = (state = 'stopped'): EventBridgeEvent<string, any> => ({
    id: 'test-event-id',
    version: '0',
    account: '123456789012',
    time: '2023-01-01T00:00:00Z',
    region: 'us-west-2',
    resources: [],
    source: 'aws.ec2',
    'detail-type': 'EC2 Instance State-change Notification',
    detail: { 'instance-id': 'i-1234567890abcdef0', state },
  });

  describe('Webhook URL Resolution', () => {
    test('resolves the webhook from the active world guild ID', async () => {
      setupWebhookMock();
      await handler(stoppedEvent(), mockContext);
      expect(getMockFetch()).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.any(Object)
      );
    });

    test('skips the post when no webhook is configured', async () => {
      await handler(stoppedEvent(), mockContext);
      expect(getMockFetch()).not.toHaveBeenCalled();
    });
  });

  describe('EC2 Instance State-change Notification Event', () => {
    test('posts the server-offline notification when EC2 stops', async () => {
      setupWebhookMock();
      await handler(stoppedEvent(), mockContext);

      expect(getMockFetch()).toHaveBeenCalled();
      const body = getFetchBody();
      // Unified lifecycle: title is the constant world name; the 🛑 status moves
      // into the description; the live-control buttons are cleared.
      expect(body.embeds[0].title).toBe('TestWorld');
      expect(body.embeds[0].description).toContain('Offline');
      expect(body.embeds[0].color).toBe(0x95a5a6);
      expect(body.components).toEqual([]);
      expect(body.content).toBe('');
    });

    test('ignores non-stopped EC2 state changes', async () => {
      setupWebhookMock();
      await handler(stoppedEvent('running'), mockContext);
      expect(getMockFetch()).not.toHaveBeenCalled();
    });

    test('edits the readiness message in place when a status-message-id exists', async () => {
      getMockSsmSend().mockImplementation((command: any) => {
        const name = command.input?.Name;
        if (name === '/gatekeeper/abiotic-factor/status-message-id') {
          return Promise.resolve({ Parameter: { Value: 'msg-123' } });
        }
        if (name === '/gatekeeper/abiotic-factor/active-world') {
          return Promise.resolve({ Parameter: { Value: JSON.stringify({ discordServerId: 'test-guild-123' }) } });
        }
        if (name === '/gatekeeper/abiotic-factor/discord-webhook/test-guild-123') {
          return Promise.resolve({ Parameter: { Value: 'https://discord.com/api/webhooks/123/abc' } });
        }
        return Promise.resolve({}); // session-private get, invalidation puts
      });
      await handler(stoppedEvent(), mockContext);

      const editCall = getMockFetch().mock.calls.find((c: any) => String(c[0]).includes('/messages/msg-123'));
      expect(editCall).toBeDefined();
      expect(editCall[1].method).toBe('PATCH');
    });

    test('schedules the status message to auto-delete after the TTL', async () => {
      getMockSsmSend().mockImplementation((command: any) => {
        const name = command.input?.Name;
        if (name === '/gatekeeper/abiotic-factor/status-message-id') return Promise.resolve({ Parameter: { Value: 'msg-123' } });
        if (name === '/gatekeeper/abiotic-factor/message-ttl-hours') return Promise.resolve({ Parameter: { Value: '16' } });
        if (name === '/gatekeeper/abiotic-factor/active-world') return Promise.resolve({ Parameter: { Value: JSON.stringify({ discordServerId: 'test-guild-123' }) } });
        if (name === '/gatekeeper/abiotic-factor/discord-webhook/test-guild-123') return Promise.resolve({ Parameter: { Value: 'https://discord.com/api/webhooks/123/abc' } });
        return Promise.resolve({});
      });
      await handler(stoppedEvent(), mockContext);

      expect(getMockSchedulerSend()).toHaveBeenCalled();
      const input = getMockSchedulerSend().mock.calls[0][0].input;
      expect(input.Name).toBe('delete-msg-msg-123');
      expect(JSON.parse(input.Target.Input)).toMatchObject({ action: 'delete-message', messageId: 'msg-123', guildId: 'test-guild-123' });
    });

    test('does not schedule a delete when TTL is off', async () => {
      getMockSsmSend().mockImplementation((command: any) => {
        const name = command.input?.Name;
        if (name === '/gatekeeper/abiotic-factor/status-message-id') return Promise.resolve({ Parameter: { Value: 'msg-123' } });
        if (name === '/gatekeeper/abiotic-factor/message-ttl-hours') return Promise.resolve({ Parameter: { Value: 'off' } });
        if (name === '/gatekeeper/abiotic-factor/active-world') return Promise.resolve({ Parameter: { Value: JSON.stringify({ discordServerId: 'test-guild-123' }) } });
        if (name === '/gatekeeper/abiotic-factor/discord-webhook/test-guild-123') return Promise.resolve({ Parameter: { Value: 'https://discord.com/api/webhooks/123/abc' } });
        return Promise.resolve({});
      });
      await handler(stoppedEvent(), mockContext);

      expect(getMockSchedulerSend()).not.toHaveBeenCalled();
    });

    test('edits the private cue to offline (private session WITH a status message)', async () => {
      getMockSsmSend().mockImplementation((command: any) => {
        const name = command.input?.Name;
        if (name === '/gatekeeper/abiotic-factor/session-private') return Promise.resolve({ Parameter: { Value: 'true' } });
        if (name === '/gatekeeper/abiotic-factor/status-message-id') return Promise.resolve({ Parameter: { Value: 'cue-77' } });
        if (name === '/gatekeeper/abiotic-factor/message-ttl-hours') return Promise.resolve({ Parameter: { Value: 'off' } });
        if (name === '/gatekeeper/abiotic-factor/active-world') return Promise.resolve({ Parameter: { Value: JSON.stringify({ discordServerId: 'test-guild-123' }) } });
        if (name === '/gatekeeper/abiotic-factor/discord-webhook/test-guild-123') return Promise.resolve({ Parameter: { Value: 'https://discord.com/api/webhooks/123/abc' } });
        return Promise.resolve({});
      });
      await handler(stoppedEvent(), mockContext);

      // Editing the cue in place (silent) — NOT a fresh public post.
      const editCall = getMockFetch().mock.calls.find((c: any) => String(c[0]).includes('/messages/cue-77'));
      expect(editCall).toBeDefined();
      expect(editCall[1].method).toBe('PATCH');
    });

    test('suppresses the offline post when private AND nothing was posted', async () => {
      getMockSsmSend().mockImplementation((command: any) => {
        if (command.input?.Name === '/gatekeeper/abiotic-factor/session-private') {
          return Promise.resolve({ Parameter: { Value: 'true' } });
        }
        return Promise.resolve({}); // PutParameter invalidations etc.
      });
      await handler(stoppedEvent(), mockContext);
      // Private session → no public "Server Offline" message.
      expect(getMockFetch()).not.toHaveBeenCalled();
    });
  });

  describe('Unknown / retired event types', () => {
    test.each(['Backup.Completed', 'Backup.Complete', 'Unknown.Event'])(
      'ignores %s (no longer handled here)',
      async (detailType) => {
        setupWebhookMock();
        const event = { ...stoppedEvent(), source: 'valheim.server', 'detail-type': detailType };
        await handler(event as any, mockContext);
        expect(getMockFetch()).not.toHaveBeenCalled();
      }
    );
  });

  describe('Error Handling', () => {
    test('continues silently when the Discord webhook fails', async () => {
      setupWebhookMock();
      getMockFetch().mockRejectedValue(new Error('Discord API Error'));
      await expect(handler(stoppedEvent(), mockContext)).resolves.not.toThrow();
    });

    test('continues silently when the SSM lookup fails', async () => {
      getMockSsmSend().mockRejectedValue(new Error('SSM Error'));
      await expect(handler(stoppedEvent(), mockContext)).resolves.not.toThrow();
    });
  });
});
