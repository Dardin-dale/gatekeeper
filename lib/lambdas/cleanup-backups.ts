import { ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BACKUP_BUCKET_NAME } from "./utils/aws-clients";

// Get the number of backups to keep from environment variables
const BACKUPS_TO_KEEP = parseInt(process.env.BACKUPS_TO_KEEP || '7', 10);

// Backups are written by scripts/game/backup-server.sh to backups/<game-id>/.
// Rotation is scoped to that prefix ONLY — seed archives (bootstrap/<game-id>/,
// pushed by `cli world push`), scripts/ and services/ are never touched.
const BACKUPS_PREFIX = 'backups/';

/**
 * Lambda handler for cleaning up old backups: keep the newest BACKUPS_TO_KEEP
 * archives per game folder under backups/, delete the rest.
 */
export async function handler(): Promise<void> {
  if (!BACKUP_BUCKET_NAME) {
    console.error('BACKUP_BUCKET_NAME environment variable is not set');
    return;
  }

  try {
    console.log(`Cleaning up backups. Keeping ${BACKUPS_TO_KEEP} most recent backups per game.`);

    // One folder per game: backups/<game-id>/
    const gamesResponse = await s3Client.send(new ListObjectsV2Command({
      Bucket: BACKUP_BUCKET_NAME,
      Prefix: BACKUPS_PREFIX,
      Delimiter: '/',
    }));

    const gameFolders = (gamesResponse.CommonPrefixes ?? [])
      .map((p) => p.Prefix)
      .filter((p): p is string => !!p);

    if (gameFolders.length === 0) {
      console.log(`No game backup folders found under ${BACKUPS_PREFIX}`);
      return;
    }

    for (const folder of gameFolders) {
      console.log(`Processing game folder: ${folder}`);
      await cleanupBackupsInFolder(folder);
    }

    console.log('Backup cleanup completed successfully for all games');
  } catch (error) {
    console.error('Error cleaning up backups:', error);
    throw error;
  }
}

/**
 * Clean up backups within a specific folder
 */
async function cleanupBackupsInFolder(folderPrefix: string): Promise<void> {
  try {
    // List all backups in the folder
    const command = new ListObjectsV2Command({
      Bucket: BACKUP_BUCKET_NAME,
      Prefix: folderPrefix
    });

    const response = await s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      console.log(`No backups found in folder: ${folderPrefix}`);
      return;
    }

    // Sort backups by last modified date (most recent first)
    const backups = response.Contents
      .filter(item => item.Key && item.Key.endsWith('.tar.gz'))
      .sort((a, b) => {
        const dateA = a.LastModified ? a.LastModified.getTime() : 0;
        const dateB = b.LastModified ? b.LastModified.getTime() : 0;
        return dateB - dateA; // Sort descending
      });

    console.log(`Found ${backups.length} backups in folder: ${folderPrefix}`);

    // Keep the most recent backups and delete the rest
    const backupsToDelete = backups.slice(BACKUPS_TO_KEEP);

    if (backupsToDelete.length === 0) {
      console.log(`No backups to delete in folder: ${folderPrefix}`);
      return;
    }

    console.log(`Deleting ${backupsToDelete.length} old backups from folder: ${folderPrefix}`);

    // Delete each old backup
    for (const backup of backupsToDelete) {
      if (backup.Key) {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: BACKUP_BUCKET_NAME,
          Key: backup.Key,
        });

        await s3Client.send(deleteCommand);
        console.log(`Deleted backup: ${backup.Key}`);
      }
    }
  } catch (error) {
    console.error(`Error cleaning up backups in folder ${folderPrefix}:`, error);
    throw error;
  }
}
