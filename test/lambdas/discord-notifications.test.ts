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
  };
});

// Mock global fetch - store in global for test access
const mockFetch = jest.fn();
(global as any).__mockFetch = mockFetch;
global.fetch = mockFetch as any;

// Get references to the actual mocks
const getMockSsmSend = () => (global as any).__mockSsmSend as jest.Mock;
const getMockFetch = () => (global as any).__mockFetch as jest.Mock;

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
      expect(body.embeds[0].title).toContain('Offline');
      expect(body.embeds[0].color).toBe(0x95a5a6);
    });

    test('ignores non-stopped EC2 state changes', async () => {
      setupWebhookMock();
      await handler(stoppedEvent('running'), mockContext);
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
