import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as Sentry from '@sentry/node';

// Load environment variables
dotenv.config();

// =============================================================================
// SENTRY CONFIGURATION
// =============================================================================

// Initialize Sentry only if DSN is provided
const sentryDsn = process.env.SENTRY_DSN;
const sentryEnabled = !!sentryDsn;

if (sentryEnabled) {
  const sentryLoggingEnabled = process.env.SENTRY_LOGGING === 'true';
  
  const integrations = [];
  
  // Add console logging integration if enabled
  if (sentryLoggingEnabled) {
    integrations.push(
      Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] })
    );
  }
  
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    release: process.env.SENTRY_RELEASE || '1.0.0',
    integrations,
    tracesSampleRate: 0.1,
    // Enable logs to be sent to Sentry (only if logging is enabled)
    enableLogs: sentryLoggingEnabled,
    beforeSend(event) {
      // Don't send S3 credentials or other sensitive data
      if (event.extra?.s3Config) {
        delete event.extra.s3Config;
      }
      return event;
    }
  });
  
  console.log(`[${new Date().toISOString()}] Sentry initialized with environment: ${process.env.SENTRY_ENVIRONMENT || 'production'}${sentryLoggingEnabled ? ' (logging enabled)' : ''}`);
} else {
  console.log(`[${new Date().toISOString()}] Sentry not initialized - no DSN provided`);
}

// =============================================================================
// CONFIGURATION
// =============================================================================

// Lock file configuration
const LOCK_FILE_PATH: string = process.env.LOCK_FILE_PATH || path.join(__dirname, '.script.lock');
const LOCK_TIMEOUT_MS: number = 30 * 60 * 1000; // 30 minutes in milliseconds

// S3/MinIO configuration
const S3_CONFIG = {
  endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
  region: process.env.S3_REGION || "us-east-1",
  accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false", // MinIO requires path-style
};

// Directory paths configuration
interface DirectoryPair {
  localDir: string;
  bucket: string;
  prefix: string;
  description: string;
}

// Define our directory pairs
const DIRECTORY_PAIRS: DirectoryPair[] = [
  {
    localDir: process.env.LOCAL_DIR_IMAGES || "./websiteImages",
    bucket: process.env.S3_BUCKET_IMAGES || "images",
    prefix: process.env.S3_PREFIX_IMAGES || "testImages",
    description: "Regular Images"
  },
  {
    localDir: process.env.LOCAL_DIR_360 || "./360Images",
    bucket: process.env.S3_BUCKET_360 || "images-360", 
    prefix: process.env.S3_PREFIX_360 || "360Images",
    description: "360-degree Images"
  }
];

// File stability threshold (30 seconds by default)
const FILE_STABILITY_THRESHOLD_MS: number = parseInt(process.env.FILE_STABILITY_THRESHOLD || "30000");

// Upload concurrency settings
const MAX_CONCURRENT_UPLOADS: number = parseInt(process.env.MAX_CONCURRENT_UPLOADS || "10");
const MAX_RETRIES: number = parseInt(process.env.MAX_RETRIES || "3");
const RETRY_BACKOFF_MS: number = 5000;

// File upload retry settings - more aggressive for handling network instability
const FILE_UPLOAD_MAX_RETRIES: number = parseInt(process.env.FILE_UPLOAD_MAX_RETRIES || "10");
const FILE_UPLOAD_INITIAL_BACKOFF_MS: number = parseInt(process.env.FILE_UPLOAD_INITIAL_BACKOFF_MS || "2000");
const FILE_UPLOAD_MAX_BACKOFF_MS: number = parseInt(process.env.FILE_UPLOAD_MAX_BACKOFF_MS || "60000");

// Sentry Cron monitoring
const SENTRY_CRON_MONITOR_ID: string | undefined = process.env.SENTRY_CRON_MONITOR_ID;

// =============================================================================
// LOCK FILE MANAGEMENT
// =============================================================================

function isScriptRunning(): boolean {
  if (!fs.existsSync(LOCK_FILE_PATH)) return false;
  
  try {
    const lockFileContent = fs.readFileSync(LOCK_FILE_PATH, 'utf8');
    const lockTimestamp = new Date(lockFileContent).getTime();
    const currentTime = Date.now();
    
    if (currentTime - lockTimestamp > LOCK_TIMEOUT_MS) {
      console.log(`[${new Date().toISOString()}] Found stale lock file (>${LOCK_TIMEOUT_MS/60000} minutes old), ignoring.`);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error reading lock file:`, err);
    return false;
  }
}

function createLockFile(): void {
  const timestamp = new Date().toISOString();
  fs.writeFileSync(LOCK_FILE_PATH, timestamp);
  console.log(`[${timestamp}] Script lock created`);
}

function removeLockFile(): void {
  if (fs.existsSync(LOCK_FILE_PATH)) {
    fs.unlinkSync(LOCK_FILE_PATH);
    console.log(`[${new Date().toISOString()}] Script lock released`);
  }
}

// =============================================================================
// FILE & DIRECTORY OPERATIONS
// =============================================================================

async function isFileStable(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return (Date.now() - stats.mtimeMs) > FILE_STABILITY_THRESHOLD_MS;
  } catch (err) {
    console.error(`Error checking file stability for ${filePath}:`, err);
    return false;
  }
}

async function getRootFolders(localDir: string): Promise<string[]> {
  try {
    // Check if directory exists
    if (!fs.existsSync(localDir)) {
      console.log(`Directory ${localDir} does not exist. Creating it.`);
      fs.mkdirSync(localDir, { recursive: true });
      return [];
    }
    
    const entries = await fs.promises.readdir(localDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(localDir, entry.name));
  } catch (err) {
    console.error(`Error getting folders from ${localDir}:`, err);
    return [];
  }
}

async function getAllFiles(folderPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const files: string[] = [];
    const subDirs: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        subDirs.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    const subDirFiles = await Promise.all(
      subDirs.map(dir => getAllFiles(dir))
    );

    return files.concat(subDirFiles.flat());
  } catch (err) {
    console.error(`Error getting files from ${folderPath}:`, err);
    return [];
  }
}

async function deleteDirectoryRecursive(dirPath: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await deleteDirectoryRecursive(fullPath);
      } else if (entry.isFile()) {
        await fs.promises.unlink(fullPath);
      }
    }

    await fs.promises.rmdir(dirPath);
  } catch (err) {
    console.error(`Error deleting directory ${dirPath}:`, err);
    throw err;
  }
}

// =============================================================================
// RETRY UTILITIES
// =============================================================================

/**
 * Executes an async function with exponential backoff retry logic.
 * @param fn The async function to execute
 * @param maxRetries Maximum number of retry attempts
 * @param initialBackoffMs Initial backoff time in milliseconds
 * @param maxBackoffMs Maximum backoff time in milliseconds
 * @param operationName Name of the operation for logging
 * @returns Result of the function
 */
async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  operationName: string
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries) {
        // Calculate exponential backoff with cap
        const backoffTime = Math.min(
          initialBackoffMs * Math.pow(2, attempt),
          maxBackoffMs
        );
        
        console.log(
          `[${new Date().toISOString()}] ${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}). ` +
          `Retrying in ${backoffTime}ms... Error: ${error instanceof Error ? error.message : String(error)}`
        );
        
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      } else {
        console.error(
          `[${new Date().toISOString()}] ${operationName} failed after ${maxRetries + 1} attempts. ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  
  throw lastError;
}

// =============================================================================
// S3 CLIENT POOL
// =============================================================================

class S3ClientPool {
  private clients: S3Client[] = [];
  private readonly maxPoolSize: number;
  private currentIndex: number = 0;
  
  constructor(maxPoolSize: number) {
    this.maxPoolSize = maxPoolSize;
    // Pre-create S3 clients for the pool
    for (let i = 0; i < maxPoolSize; i++) {
      this.clients.push(this.createNewClient());
    }
  }
  
  getClient(): S3Client {
    // Round-robin distribution of clients
    const client = this.clients[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return client;
  }
  
  private createNewClient(): S3Client {
    return new S3Client({
      endpoint: S3_CONFIG.endpoint,
      region: S3_CONFIG.region,
      credentials: {
        accessKeyId: S3_CONFIG.accessKeyId,
        secretAccessKey: S3_CONFIG.secretAccessKey,
      },
      forcePathStyle: S3_CONFIG.forcePathStyle,
    });
  }
  
  async closeAll(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients = [];
  }
}

// =============================================================================
// S3 OPERATIONS
// =============================================================================

async function createS3Client(): Promise<S3Client> {
  try {
    const client = new S3Client({
      endpoint: S3_CONFIG.endpoint,
      region: S3_CONFIG.region,
      credentials: {
        accessKeyId: S3_CONFIG.accessKeyId,
        secretAccessKey: S3_CONFIG.secretAccessKey,
      },
      forcePathStyle: S3_CONFIG.forcePathStyle,
    });
    
    return client;
  } catch (error) {
    if (sentryEnabled) {
      Sentry.captureException(error, {
        tags: { operation: 's3_connection' },
        extra: { endpoint: S3_CONFIG.endpoint, region: S3_CONFIG.region }
      });
    }
    throw error;
  }
}

async function uploadFileToS3(
  file: string, 
  s3Key: string, 
  bucket: string,
  clientPool: S3ClientPool
): Promise<void> {
  const fileName = path.basename(file);
  
  await retryWithExponentialBackoff(
    async () => {
      const client = clientPool.getClient();
      
      try {
        const fileStream = fs.createReadStream(file);
        const stats = await fs.promises.stat(file);
        
        // Use multipart upload for files larger than 5MB
        if (stats.size > 5 * 1024 * 1024) {
          const upload = new Upload({
            client,
            params: {
              Bucket: bucket,
              Key: s3Key,
              Body: fileStream,
            },
            queueSize: 4,
            partSize: 5 * 1024 * 1024, // 5MB parts
            leavePartsOnError: false,
          });
          
          await upload.done();
        } else {
          // Use simple upload for smaller files
          const command = new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: fileStream,
          });
          
          await client.send(command);
        }
      } catch (error) {
        if (sentryEnabled) {
          Sentry.captureException(error, {
            tags: { operation: 'file_upload' },
            extra: { 
              file: fileName,
              s3Key,
              bucket 
            }
          });
        }
        throw error;
      }
    },
    FILE_UPLOAD_MAX_RETRIES,
    FILE_UPLOAD_INITIAL_BACKOFF_MS,
    FILE_UPLOAD_MAX_BACKOFF_MS,
    `Upload ${fileName}`
  );
}

async function uploadFilesInParallel(
  files: string[], 
  folderPath: string, 
  s3Prefix: string,
  bucket: string,
  clientPool: S3ClientPool
): Promise<boolean> {
  let uploadErrors = 0;
  const filesToProcess = [...files];
  const activePromises: Promise<void>[] = [];
  
  // Process files in batches to maintain concurrency limit
  while (filesToProcess.length > 0 || activePromises.length > 0) {
    // Start new uploads if under limit
    while (activePromises.length < MAX_CONCURRENT_UPLOADS && filesToProcess.length > 0) {
      const file = filesToProcess.shift()!;
      const relativePath = path.relative(folderPath, file);
      // Use forward slashes for S3 keys
      const s3Key = path.posix.join(s3Prefix, relativePath.replace(/\\/g, '/'));
      
      console.log(`Starting upload ${activePromises.length+1}/${MAX_CONCURRENT_UPLOADS}: ${path.basename(file)}`);
      
      const uploadPromise = uploadFileToS3(file, s3Key, bucket, clientPool)
        .then(() => console.log(`Completed upload: ${path.basename(file)}`))
        .catch(err => {
          console.error(`Error uploading ${path.basename(file)}:`, err);
          uploadErrors++;
          return Promise.resolve(); // Continue despite error
        });
      
      // Track this promise and remove it when done
      const trackingPromise = uploadPromise.finally(() => {
        const index = activePromises.indexOf(trackingPromise);
        if (index !== -1) activePromises.splice(index, 1);
      });
      
      activePromises.push(trackingPromise);
    }
    
    // If we've hit the limit or exhausted files, wait for some to complete
    if (activePromises.length > 0) {
      await Promise.race(activePromises);
    }
  }
  
  if (uploadErrors > 0) {
    console.log(`${uploadErrors} files failed to upload to bucket ${bucket}`);
    return false;
  }
  
  return true;
}

// =============================================================================
// FOLDER PROCESSING
// =============================================================================

async function processFolder(folderPath: string, s3Prefix: string, bucket: string, clientPool: S3ClientPool): Promise<boolean> {
  const folderName = path.basename(folderPath);
  console.log(`\nProcessing folder: ${folderName}`);
  
  try {
    // Get all files and check stability
    const files = await getAllFiles(folderPath);
    console.log(`Found ${files.length} total files in ${folderName}`);
    
    if (files.length === 0) {
      console.log(`Folder ${folderName} is empty, will delete it`);
      await deleteDirectoryRecursive(folderPath);
      return true;
    }
    
    for (const file of files) {
      if (!(await isFileStable(file))) {
        console.log(`Folder ${folderName} contains unstable files, skipping`);
        return false;
      }
    }
    
    // Create S3 prefix (folder structure in bucket)
    const s3FolderPrefix = path.posix.join(s3Prefix, folderName);
    
    // Upload all files in parallel
    const success = await uploadFilesInParallel(
      files, 
      folderPath, 
      s3FolderPrefix,
      bucket,
      clientPool
    );
    
    // Clean up if all files uploaded successfully
    if (success) {
      console.log(`All files uploaded successfully, deleting folder: ${folderName}`);
      
      // Delete files first, then directories
      for (const file of files) {
        await fs.promises.unlink(file);
      }
      
      await deleteDirectoryRecursive(folderPath);
      return true;
    } else {
      console.log(`Skipping deletion of folder ${folderName} due to upload errors`);
      return false;
    }
  } catch (err) {
    console.error(`Error processing folder ${folderPath}:`, err);
    return false;
  }
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

async function uploadFiles(): Promise<void> {
  // Check if another instance is already running
  if (isScriptRunning()) {
    console.log(`[${new Date().toISOString()}] Another instance is already running. Exiting.`);
    return;
  }

  // Create lock file
  createLockFile();
  
  // Start Sentry cron monitoring if configured
  let cronCheckInId: string | undefined;
  if (sentryEnabled && SENTRY_CRON_MONITOR_ID) {
    cronCheckInId = Sentry.captureCheckIn({
      monitorSlug: SENTRY_CRON_MONITOR_ID,
      status: 'in_progress'
    });
    console.log(`[${new Date().toISOString()}] Sentry cron monitoring started`);
  }
  
  let retries = 0;
  let success = false;
  
  try {
    while (retries < MAX_RETRIES) {
      // Create S3 client pool for parallel uploads
      const clientPool = new S3ClientPool(MAX_CONCURRENT_UPLOADS);
      
      try {
        // Create main S3 client for bucket verification
        console.log(`[${new Date().toISOString()}] Connecting to S3/MinIO server...`);
        const client = await createS3Client();
        
        try {
          // Verify buckets exist
          for (const dirPair of DIRECTORY_PAIRS) {
            try {
              await client.send(new HeadBucketCommand({ Bucket: dirPair.bucket }));
              console.log(`[${new Date().toISOString()}] Verified bucket exists: ${dirPair.bucket}`);
            } catch (err) {
              console.error(`[${new Date().toISOString()}] Bucket ${dirPair.bucket} does not exist or is not accessible:`, err);
              throw new Error(`Bucket ${dirPair.bucket} is not accessible`);
            }
          }
          
          // Process each directory pair
          for (const dirPair of DIRECTORY_PAIRS) {
            console.log(`[${new Date().toISOString()}] Processing ${dirPair.description}: ${dirPair.localDir} -> s3://${dirPair.bucket}/${dirPair.prefix}`);
            
            // Process all folders in this local directory
            const folders = await getRootFolders(dirPair.localDir);
            console.log(`[${new Date().toISOString()}] Found ${folders.length} folders to process in ${dirPair.localDir}`);
            
            for (const folder of folders) {
              await processFolder(folder, dirPair.prefix, dirPair.bucket, clientPool);
            }
          }
          
          // Success - exit retry loop
          success = true;
          break;
        } finally {
          // Always close the client pool
          client.destroy();
          await clientPool.closeAll();
          console.log(`[${new Date().toISOString()}] S3 connections closed`);
        }
      } catch (err) {
        retries++;
        console.error(`[${new Date().toISOString()}] Error in S3 upload process (attempt ${retries}/${MAX_RETRIES}):`, err);
        
        if (sentryEnabled) {
          Sentry.captureException(err, {
            tags: { 
              operation: 'main_upload_process',
              retry_attempt: retries 
            }
          });
        }
        
        if (retries < MAX_RETRIES) {
          const backoffTime = RETRY_BACKOFF_MS * retries;
          console.log(`[${new Date().toISOString()}] Retrying in ${backoffTime/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
      }
    }
  } finally {
    // Complete Sentry cron monitoring
    if (sentryEnabled && SENTRY_CRON_MONITOR_ID && cronCheckInId) {
      Sentry.captureCheckIn({
        checkInId: cronCheckInId,
        monitorSlug: SENTRY_CRON_MONITOR_ID,
        status: success ? 'ok' : 'error'
      });
      console.log(`[${new Date().toISOString()}] Sentry cron monitoring completed with status: ${success ? 'ok' : 'error'}`);
    }
    
    // Always remove lock file when done
    removeLockFile();
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
  if (sentryEnabled) {
    Sentry.captureException(error, { tags: { type: 'uncaught_exception' } });
  }
  removeLockFile();
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, error);
  if (sentryEnabled) {
    Sentry.captureException(error, { tags: { type: 'unhandled_rejection' } });
  }
  removeLockFile();
  process.exit(1);
});

// Run the script
uploadFiles().catch(err => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
  if (sentryEnabled) {
    Sentry.captureException(err, { tags: { type: 'main_function_error' } });
  }
  removeLockFile();
  process.exit(1);
});

