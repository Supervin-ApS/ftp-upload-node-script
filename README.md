# S3/MinIO Upload Node Script

A robust Node.js TypeScript application for uploading files to S3-compatible storage (MinIO) with comprehensive retry logic to handle network instability.

## Features

- **S3/MinIO Compatible**: Works with AWS S3, MinIO, and other S3-compatible storage
- **Multipart Uploads**: Automatic multipart upload for large files (>5MB) for better performance
- **Robust Retry Mechanism**: Automatic retry with exponential backoff for failed uploads
- **Parallel Uploads**: Configurable concurrent upload support
- **Network Error Handling**: Handles timeout errors and network failures
- **File Stability Checks**: Ensures files are completely written before upload
- **Lock File Management**: Prevents concurrent script executions
- **Sentry Integration**: Optional error monitoring and cron job tracking
- **Multiple Bucket Support**: Upload from multiple local directories to different S3 buckets/prefixes

## MinIO Setup

### Installation

1. **Install MinIO Server**:
   ```bash
   # Using Docker (recommended)
   docker run -p 9000:9000 -p 9001:9001 \
     --name minio \
     -e "MINIO_ROOT_USER=minioadmin" \
     -e "MINIO_ROOT_PASSWORD=minioadmin" \
     -v /path/to/data:/data \
     quay.io/minio/minio server /data --console-address ":9001"
   
   # Or download binary from https://min.io/download
   ```

2. **Access MinIO Console**: Navigate to `http://localhost:9001` and login with your credentials

3. **Create Buckets**:
   - Create a bucket for regular images (e.g., `images`)
   - Create a bucket for 360-degree images (e.g., `images-360`)
   - Or use a single bucket with different prefixes

4. **Generate Access Keys**:
   - In MinIO Console, go to "Access Keys"
   - Create a new access key pair
   - Save the Access Key ID and Secret Access Key

### Lifecycle Policies (Optional)

To automatically delete or archive old files:

1. Go to MinIO Console → Buckets → Select bucket → Lifecycle
2. Add a new rule:
   - **Expiration**: Delete objects after X days
   - **Prefix**: Target specific folders (e.g., `testImages/`)
   
Example policy for 30-day retention:
```json
{
  "Rules": [
    {
      "Expiration": {
        "Days": 30
      },
      "ID": "DeleteOldImages",
      "Status": "Enabled",
      "Prefix": "testImages/"
    }
  ]
}
```

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
- **Server-friendly** exponential backoff prevents overwhelming the S3 server during issues

## Configuration

### S3/MinIO Settings

- `S3_ENDPOINT` - S3/MinIO server endpoint (e.g., `http://localhost:9000` for local MinIO)
- `S3_REGION` - AWS region (default: `us-east-1`, not critical for MinIO)
- `S3_ACCESS_KEY_ID` - Access key ID for S3/MinIO
- `S3_SECRET_ACCESS_KEY` - Secret access key for S3/MinIO
- `S3_FORCE_PATH_STYLE` (default: `true`) - Use path-style URLs (required for MinIO)

### Bucket and Prefix Configuration

**Regular Images:**
- `S3_BUCKET_IMAGES` (default: `images`) - Bucket name for regular images
- `S3_PREFIX_IMAGES` (default: `testImages`) - Prefix/folder path in bucket
- `LOCAL_DIR_IMAGES` (default: `./websiteImages`) - Local directory for regular images

**360-degree Images:**
- `S3_BUCKET_360` (default: `images-360`) - Bucket name for 360-degree images
- `S3_PREFIX_360` (default: `360Images`) - Prefix/folder path in bucket
- `LOCAL_DIR_360` (default: `./360Images`) - Local directory for 360-degree images

### Upload Settings

- `MAX_CONCURRENT_UPLOADS` (default: `10`) - Number of concurrent file uploads. **This is the primary setting for upload speed.**
  - **For faster uploads**: Increase this value (e.g., 15-20 for ~300 images)
  - **Conservative/slow connection**: Use lower values (e.g., 5-8)
  - **Note**: The script uses S3 client pooling to efficiently manage connections
- `FILE_STABILITY_THRESHOLD` (default: `30000`) - Time in ms to wait before considering a file stable

#### Performance Tuning for Large Batches

When uploading large batches of images (e.g., ~300 360-degree images):

1. **Increase concurrent uploads**: Set `MAX_CONCURRENT_UPLOADS=15` or higher for faster throughput
2. **Monitor server load**: Higher concurrency may strain the MinIO server or network
3. **Connection pooling**: The script automatically manages S3 client connections for optimal performance

**Recommended configuration for ~300 images:**
```bash
# Fast upload configuration
MAX_CONCURRENT_UPLOADS=20
FILE_UPLOAD_MAX_RETRIES=10
FILE_UPLOAD_INITIAL_BACKOFF_MS=2000
```

**Expected Performance:**
- S3/MinIO uploads are typically 2-5x faster than FTPS
- Multipart uploads provide better performance for large files
- Parallel uploads scale linearly up to network bandwidth limits

### Using with Bun.sh

This script works great with Bun.sh and benefits from Bun's faster I/O performance:

```bash
bun run dist/index.js
```

**Note**: Bun Workers are not recommended for this use case because uploads are **I/O-bound** (network limited), not CPU-bound. The script already uses optimal async parallelism.

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

## How It Works

1. Script checks for a lock file to prevent concurrent executions
2. Creates lock file and verifies S3/MinIO bucket accessibility
3. Scans configured local directories for folders to upload
4. For each folder:
   - Checks that all files are stable (not currently being written)
   - Uploads files in parallel to S3 (respecting concurrency limits)
   - Uses multipart upload for large files (>5MB) for better performance
   - Each file upload is wrapped with retry logic
   - Deletes local folder after successful upload
5. Removes lock file when complete

## Migration from FTPS

This script has been migrated from FTPS to S3/MinIO. Key benefits:

- **Faster uploads**: S3 protocol is more efficient than FTP/FTPS
- **Better scalability**: Horizontal scaling with multiple MinIO nodes
- **Modern API**: Standard S3 API with extensive tooling support
- **Full control**: Self-hosted on-premise storage
- **No FTP dependencies**: Eliminated legacy protocol complexity

## License

ISC
