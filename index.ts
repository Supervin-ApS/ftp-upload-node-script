import * as ftp from 'basic-ftp';
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
      // Don't send FTP credentials or other sensitive data
      if (event.extra?.ftpConfig) {
        delete event.extra.ftpConfig;
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

// FTPS server configuration
const FTP_CONFIG = {
  host: process.env.FTP_HOST || "185.21.43.26",
  user: process.env.FTP_USER || "imageupload",
  password: process.env.FTP_PASSWORD || "",
  port: parseInt(process.env.FTP_PORT || "21"),
  secure: process.env.FTP_SECURE === "true",
};

// Directory paths configuration
interface DirectoryPair {
  localDir: string;
  remoteDir: string;
  description: string;
}

// Define our directory pairs
const DIRECTORY_PAIRS: DirectoryPair[] = [
  {
    localDir: process.env.LOCAL_DIR_IMAGES || "./websiteImages",
    remoteDir: process.env.REMOTE_DIR_IMAGES || "/testImages",
    description: "Regular Images"
  },
  {
    localDir: process.env.LOCAL_DIR_360 || "./360Images",
    remoteDir: process.env.REMOTE_DIR_360 || "/360Images", 
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
// FTP CONNECTION POOL
// =============================================================================

class FtpConnectionPool {
  private availableClients: ftp.Client[] = [];
  private activeClients: Set<ftp.Client> = new Set();
  private readonly maxPoolSize: number;
  
  constructor(maxPoolSize: number) {
    this.maxPoolSize = maxPoolSize;
  }
  
  async acquire(): Promise<ftp.Client> {
    // Try to get an available client from the pool
    if (this.availableClients.length > 0) {
      const client = this.availableClients.pop()!;
      this.activeClients.add(client);
      return client;
    }
    
    // Create a new client if we haven't reached the pool size
    if (this.activeClients.size < this.maxPoolSize) {
      const client = await this.createNewClient();
      this.activeClients.add(client);
      return client;
    }
    
    // Wait for a client to become available
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.availableClients.length > 0) {
          clearInterval(checkInterval);
          const client = this.availableClients.pop()!;
          this.activeClients.add(client);
          resolve(client);
        }
      }, 100);
    });
  }
  
  release(client: ftp.Client): void {
    this.activeClients.delete(client);
    // Only keep the client if it's still connected
    if (client.closed === false) {
      this.availableClients.push(client);
    }
  }
  
  private async createNewClient(): Promise<ftp.Client> {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    
    try {
      await client.access(FTP_CONFIG);
      await client.send("TYPE I");
      
      if (client.ftp.socket) {
        client.ftp.socket.setKeepAlive(true);
      }
      
      return client;
    } catch (error) {
      if (sentryEnabled) {
        Sentry.captureException(error, {
          tags: { operation: 'ftp_connection_pool' },
          extra: { host: FTP_CONFIG.host, port: FTP_CONFIG.port }
        });
      }
      throw error;
    }
  }
  
  async closeAll(): Promise<void> {
    // Close all available clients
    for (const client of this.availableClients) {
      client.close();
    }
    this.availableClients = [];
    
    // Close all active clients
    for (const client of this.activeClients) {
      client.close();
    }
    this.activeClients.clear();
  }
}

// =============================================================================
// FTP OPERATIONS
// =============================================================================

async function createFtpClient(): Promise<ftp.Client> {
  const client = new ftp.Client();
  client.ftp.verbose = process.env.FTP_VERBOSE === "true";
  
  try {
    await client.access(FTP_CONFIG);
    await client.send("TYPE I"); // Set binary mode
    
    if (client.ftp.socket) {
      client.ftp.socket.setKeepAlive(true);
    }
    
    return client;
  } catch (error) {
    if (sentryEnabled) {
      Sentry.captureException(error, {
        tags: { operation: 'ftp_connection' },
        extra: { host: FTP_CONFIG.host, port: FTP_CONFIG.port }
      });
    }
    throw error;
  }
}

async function uploadFileWithPooledClient(
  file: string, 
  remotePath: string, 
  remoteDir: string,
  connectionPool: FtpConnectionPool
): Promise<void> {
  const fileName = path.basename(file);
  
  await retryWithExponentialBackoff(
    async () => {
      const client = await connectionPool.acquire();
      
      try {
        await client.ensureDir(remoteDir);
        await client.uploadFrom(file, remotePath);
      } catch (error) {
        if (sentryEnabled) {
          Sentry.captureException(error, {
            tags: { operation: 'file_upload' },
            extra: { 
              file: fileName,
              remotePath,
              remoteDir 
            }
          });
        }
        throw error;
      } finally {
        connectionPool.release(client);
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
  remoteFolderPath: string,
  remoteDir: string,
  connectionPool: FtpConnectionPool
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
      const remotePath = path.posix.join(remoteFolderPath, relativePath);
      
      console.log(`Starting upload ${activePromises.length+1}/${MAX_CONCURRENT_UPLOADS}: ${path.basename(file)}`);
      
      const uploadPromise = uploadFileWithPooledClient(file, remotePath, remoteDir, connectionPool)
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
    console.log(`${uploadErrors} files failed to upload in directory ${remoteDir}`);
    return false;
  }
  
  return true;
}

// =============================================================================
// FOLDER PROCESSING
// =============================================================================

async function processFolder(folderPath: string, client: ftp.Client, remoteBaseDir: string, connectionPool: FtpConnectionPool): Promise<boolean> {
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
    
    // Create remote directory structure
    const remoteFolderPath = path.posix.join(remoteBaseDir, folderName);
    await client.ensureDir(remoteFolderPath);
    
    // Group files by directory
    const filesByDir: Record<string, string[]> = {};
    for (const file of files) {
      const relativePath = path.relative(folderPath, file);
      const remoteDir = path.posix.dirname(path.posix.join(remoteFolderPath, relativePath));
      
      if (!filesByDir[remoteDir]) filesByDir[remoteDir] = [];
      filesByDir[remoteDir].push(file);
    }
    
    // Upload files directory by directory
    let allSuccessful = true;
    
    for (const remoteDir of Object.keys(filesByDir)) {
      // Ensure directory exists on remote server
      await client.ensureDir(remoteDir);
      
      // Upload files in this directory in parallel
      const success = await uploadFilesInParallel(
        filesByDir[remoteDir], 
        folderPath, 
        remoteFolderPath,
        remoteDir,
        connectionPool
      );
      
      if (!success) allSuccessful = false;
    }
    
    // Clean up if all files uploaded successfully
    if (allSuccessful) {
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
      // Create connection pool for parallel uploads
      const connectionPool = new FtpConnectionPool(MAX_CONCURRENT_UPLOADS);
      
      try {
        // Create main FTP client
        console.log(`[${new Date().toISOString()}] Connecting to FTPS server...`);
        const client = await createFtpClient();
        
        try {
          // Process each directory pair
          for (const dirPair of DIRECTORY_PAIRS) {
            console.log(`[${new Date().toISOString()}] Processing ${dirPair.description}: ${dirPair.localDir} -> ${dirPair.remoteDir}`);
            
            // Process all folders in this local directory
            const folders = await getRootFolders(dirPair.localDir);
            console.log(`[${new Date().toISOString()}] Found ${folders.length} folders to process in ${dirPair.localDir}`);
            
            for (const folder of folders) {
              await processFolder(folder, client, dirPair.remoteDir, connectionPool);
            }
          }
          
          // Success - exit retry loop
          success = true;
          break;
        } finally {
          // Always close the client and connection pool
          client.close();
          await connectionPool.closeAll();
          console.log(`[${new Date().toISOString()}] FTPS connection closed`);
        }
      } catch (err) {
        retries++;
        console.error(`[${new Date().toISOString()}] Error in FTPS process (attempt ${retries}/${MAX_RETRIES}):`, err);
        
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

