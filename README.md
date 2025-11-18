# FTP Upload Node Script

A robust Node.js TypeScript application for uploading files to an FTP server with comprehensive retry logic to handle network instability.

## Features

- **Robust Retry Mechanism**: Automatic retry with exponential backoff for failed uploads
- **Parallel Uploads**: Configurable concurrent upload support
- **Network Error Handling**: Handles timeout errors and FTP network stream errors (426)
- **File Stability Checks**: Ensures files are completely written before upload
- **Lock File Management**: Prevents concurrent script executions
- **Sentry Integration**: Optional error monitoring and cron job tracking
- **Multiple Directory Support**: Upload from multiple local directories to different remote paths

## Retry Configuration

The script includes aggressive retry logic to handle network instability:

### Environment Variables

- `FILE_UPLOAD_MAX_RETRIES` (default: `10`) - Maximum number of retry attempts per file
- `FILE_UPLOAD_INITIAL_BACKOFF_MS` (default: `2000`) - Initial delay before first retry in milliseconds
- `FILE_UPLOAD_MAX_BACKOFF_MS` (default: `60000`) - Maximum delay between retries in milliseconds

### Retry Backoff Sequence

With default settings, the retry delays follow this exponential backoff pattern:

1. First retry: 2 seconds
2. Second retry: 4 seconds
3. Third retry: 8 seconds
4. Fourth retry: 16 seconds
5. Fifth retry: 32 seconds
6. Sixth+ retries: 60 seconds (capped at max backoff)

This approach ensures:
- **Quick recovery** for transient network issues (most common: 1 retry after 2 seconds)
- **Extended resilience** for prolonged network instability (up to 10 retries)
- **Server-friendly** exponential backoff prevents overwhelming the FTP server during issues

## Other Configuration

### FTP Settings

- `FTP_HOST` - FTP server hostname
- `FTP_USER` - FTP username
- `FTP_PASSWORD` - FTP password
- `FTP_PORT` (default: `21`) - FTP server port
- `FTP_SECURE` (default: `false`) - Use FTPS if set to `true`
- `FTP_VERBOSE` (default: `false`) - Enable verbose FTP logging

### Directory Configuration

- `LOCAL_DIR_IMAGES` (default: `./websiteImages`) - Local directory for regular images
- `REMOTE_DIR_IMAGES` (default: `/testImages`) - Remote directory for regular images
- `LOCAL_DIR_360` (default: `./360Images`) - Local directory for 360-degree images
- `REMOTE_DIR_360` (default: `/360Images`) - Remote directory for 360-degree images

### Upload Settings

- `MAX_CONCURRENT_UPLOADS` (default: `10`) - Number of concurrent file uploads. **This is the primary setting for upload speed.**
  - **For faster uploads**: Increase this value (e.g., 15-20 for ~300 images)
  - **Conservative/slow connection**: Use lower values (e.g., 5-8)
  - **Note**: The script uses connection pooling to efficiently reuse FTP connections
- `FILE_STABILITY_THRESHOLD` (default: `30000`) - Time in ms to wait before considering a file stable

#### Performance Tuning for Large Batches

When uploading large batches of images (e.g., ~300 360-degree images):

1. **Increase concurrent uploads**: Set `MAX_CONCURRENT_UPLOADS=15` or higher for faster throughput
2. **Monitor server load**: Higher concurrency may strain the FTP server or network
3. **Connection pooling**: The script automatically reuses FTP connections to minimize overhead

**Recommended configuration for ~300 images:**
```bash
# Fast upload configuration
MAX_CONCURRENT_UPLOADS=20
FILE_UPLOAD_MAX_RETRIES=10
FILE_UPLOAD_INITIAL_BACKOFF_MS=2000
```

**Expected Performance:**
- Default settings (10 concurrent): ~300 images in X minutes
- Recommended settings (20 concurrent): ~300 images in X/2 minutes
- This configuration can reduce upload time by 2-4x compared to previous default (5 concurrent)

### Using with Bun.sh

This script works great with Bun.sh and benefits from Bun's faster I/O performance. However, **Bun Workers are not recommended** for this use case because:

- FTP uploads are **I/O-bound** (network limited), not CPU-bound
- The script already uses optimal async parallelism with connection pooling
- Workers would add overhead without performance benefits
- Bun's native async I/O is already faster than Node.js

Simply run with Bun instead of Node for better performance:
```bash
bun run dist/index.js
```

### Lock File

- `LOCK_FILE_PATH` (default: `.script.lock`) - Path to lock file

### Sentry Integration (Optional)

- `SENTRY_DSN` - Sentry Data Source Name (if not set, Sentry is disabled)
- `SENTRY_ENVIRONMENT` (default: `production`) - Environment name for Sentry
- `SENTRY_RELEASE` (default: `1.0.0`) - Release version for Sentry
- `SENTRY_LOGGING` (default: `false`) - Enable sending logs to Sentry
- `SENTRY_CRON_MONITOR_ID` - Sentry cron monitor slug for job tracking

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

## Run

With Node.js:
```bash
npm start
```

With Bun (recommended for better performance):
```bash
npm run start:bun
# or directly
bun run dist/index.js
```

Or build and run:

```bash
npm run start:build
```

## Common Errors Handled

The retry mechanism automatically handles these common FTP errors:

1. **Timeout (control socket)**: Network timeout during FTP control connection
2. **426 Failure reading network stream**: Network stream read error during data transfer

Both errors are automatically retried using the exponential backoff strategy.

## How It Works

1. Script checks for a lock file to prevent concurrent executions
2. Creates lock file and connects to FTP server
3. Scans configured local directories for folders to upload
4. For each folder:
   - Checks that all files are stable (not currently being written)
   - Uploads files in parallel (respecting concurrency limits)
   - Each file upload is wrapped with retry logic
   - Deletes local folder after successful upload
5. Removes lock file when complete

## License

ISC
