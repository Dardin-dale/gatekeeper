// Create a mock module that stores the send function in global for test access
jest.mock('../../lib/lambdas/utils/aws-clients', () => {
  const actualMockSend = jest.fn();
  (global as any).__mockS3Send = actualMockSend;

  return {
    s3Client: { send: actualMockSend },
    BACKUP_BUCKET_NAME: 'test-backup-bucket',
    ec2Client: {},
    ssmClient: {},
    SERVER_INSTANCE_ID: 'test-instance',
    withRetry: async <T>(operation: () => Promise<T>) => operation(),
  };
});

// Get reference to the actual mock
const getMockSend = () => (global as any).__mockS3Send as jest.Mock;

// Import after mocking
import { handler } from '../../lib/lambdas/cleanup-backups';

// Build N timestamped backup entries under a game folder, oldest first.
function backups(folder: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    Key: `${folder}backup${i + 1}.tar.gz`,
    LastModified: new Date(2023, 0, i + 1),
  }));
}

describe('Cleanup Backups Lambda', () => {
  beforeEach(() => {
    // Reset the mock between tests
    getMockSend().mockReset();
  });

  test('No game folders found makes no deletes', async () => {
    getMockSend().mockResolvedValue({ CommonPrefixes: [], Contents: [] });

    await handler();

    expect(getMockSend()).toHaveBeenCalledTimes(1); // just the backups/ folder listing
    const call = getMockSend().mock.calls[0][0];
    expect(call.constructor.name).toBe('ListObjectsV2Command');
    expect(call.input.Prefix).toBe('backups/');
  });

  test('Fewer than BACKUPS_TO_KEEP backups are all kept', async () => {
    getMockSend().mockImplementation((command: any) => {
      if (command.input.Delimiter === '/') {
        return Promise.resolve({ CommonPrefixes: [{ Prefix: 'backups/abiotic-factor/' }] });
      }
      return Promise.resolve({ Contents: backups('backups/abiotic-factor/', 2) });
    });

    await handler();

    const deleteCommands = getMockSend().mock.calls.filter((call: any) =>
      call[0].constructor.name === 'DeleteObjectCommand'
    );
    expect(deleteCommands).toHaveLength(0);
  });

  test('More than BACKUPS_TO_KEEP backups deletes the oldest ones', async () => {
    getMockSend().mockImplementation((command: any) => {
      if (command.constructor.name === 'DeleteObjectCommand') {
        return Promise.resolve({});
      }
      if (command.input.Delimiter === '/') {
        return Promise.resolve({ CommonPrefixes: [{ Prefix: 'backups/abiotic-factor/' }] });
      }
      return Promise.resolve({ Contents: backups('backups/abiotic-factor/', 9) });
    });

    await handler();

    // 9 backups, keep 7 (default) -> delete the 2 oldest
    const deletedKeys = getMockSend().mock.calls
      .filter((call: any) => call[0].constructor.name === 'DeleteObjectCommand')
      .map((call: any) => call[0].input.Key);
    expect(deletedKeys).toHaveLength(2);
    expect(deletedKeys).toContain('backups/abiotic-factor/backup1.tar.gz');
    expect(deletedKeys).toContain('backups/abiotic-factor/backup2.tar.gz');
  });

  test('Non-archive files are ignored', async () => {
    getMockSend().mockImplementation((command: any) => {
      if (command.constructor.name === 'DeleteObjectCommand') {
        return Promise.resolve({});
      }
      if (command.input.Delimiter === '/') {
        return Promise.resolve({ CommonPrefixes: [{ Prefix: 'backups/abiotic-factor/' }] });
      }
      return Promise.resolve({
        Contents: [
          ...backups('backups/abiotic-factor/', 8),
          { Key: 'backups/abiotic-factor/readme.txt', LastModified: new Date(2023, 0, 20) },
          { Key: 'backups/abiotic-factor/config.json', LastModified: new Date(2023, 0, 21) },
        ],
      });
    });

    await handler();

    // 8 .tar.gz, keep 7, delete 1; the .txt/.json never count or get deleted
    const deletedKeys = getMockSend().mock.calls
      .filter((call: any) => call[0].constructor.name === 'DeleteObjectCommand')
      .map((call: any) => call[0].input.Key);
    expect(deletedKeys).toHaveLength(1);
    expect(deletedKeys).not.toContain('backups/abiotic-factor/readme.txt');
    expect(deletedKeys).not.toContain('backups/abiotic-factor/config.json');
  });

  test('Multiple game folders are rotated independently', async () => {
    getMockSend().mockImplementation((command: any) => {
      if (command.constructor.name === 'DeleteObjectCommand') {
        return Promise.resolve({});
      }
      const input = command.input;
      if (input.Delimiter === '/') {
        return Promise.resolve({
          CommonPrefixes: [
            { Prefix: 'backups/abiotic-factor/' },
            { Prefix: 'backups/valheim/' },
          ],
        });
      }
      if (input.Prefix === 'backups/abiotic-factor/') {
        return Promise.resolve({ Contents: backups('backups/abiotic-factor/', 9) });
      }
      if (input.Prefix === 'backups/valheim/') {
        return Promise.resolve({ Contents: backups('backups/valheim/', 2) });
      }
      return Promise.resolve({ Contents: [] });
    });

    await handler();

    // AF: 9 backups -> delete 2; Valheim: 2 backups -> delete none
    const deletedKeys = getMockSend().mock.calls
      .filter((call: any) => call[0].constructor.name === 'DeleteObjectCommand')
      .map((call: any) => call[0].input.Key);
    expect(deletedKeys).toHaveLength(2);
    expect(deletedKeys.every((key: string) => key.startsWith('backups/abiotic-factor/'))).toBe(true);
  });

  test('Seed archives under bootstrap/ are never listed for rotation', async () => {
    getMockSend().mockImplementation((command: any) => {
      if (command.input.Delimiter === '/') {
        return Promise.resolve({ CommonPrefixes: [{ Prefix: 'backups/abiotic-factor/' }] });
      }
      return Promise.resolve({ Contents: backups('backups/abiotic-factor/', 1) });
    });

    await handler();

    // Every list call stays under backups/ — bootstrap/ is out of scope by construction.
    const listPrefixes = getMockSend().mock.calls
      .filter((call: any) => call[0].constructor.name === 'ListObjectsV2Command')
      .map((call: any) => call[0].input.Prefix);
    expect(listPrefixes.length).toBeGreaterThan(0);
    expect(listPrefixes.every((p: string) => p.startsWith('backups/'))).toBe(true);
  });

  test('Error handling when S3 operations fail', async () => {
    // Setup: S3 throws an error
    getMockSend().mockRejectedValue(new Error('S3 API Error'));

    await expect(handler()).rejects.toThrow('S3 API Error');
  });
});
