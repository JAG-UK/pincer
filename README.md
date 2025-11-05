# PinCeR

🦞 **PinCeR** (Pincer) is a full OCI Container Registry that stores images in Filecoin Pin/IPFS. Use standard Docker/containerd tools to push and pull images - PinCeR handles all the Filecoin Pin integration transparently.

## Features

- ✅ **Full OCI Distribution Spec** - Supports both push and pull operations
- ✅ **Standard Docker/containerd tools** - Works with `docker push/pull`, `crane`, `skopeo`, etc.
- ✅ **Automatic Filecoin Pin integration** - Images are automatically uploaded to Filecoin Pin when pushed
- ✅ **IPFS-backed storage** - Images are stored in IPFS and served via IPFS gateways
- ✅ **Content-addressable** - Uses IPFS CIDs for immutable, content-addressable storage
- ✅ **Zero configuration** - Push images normally, PinCeR handles everything

## Architecture

PinCeR implements the full OCI Distribution Spec HTTP API, acting as a transparent proxy to Filecoin Pin:

```
Push:  Docker/containerd → PinCeR → Filecoin Pin → IPFS
Pull:  Docker/containerd → PinCeR → IPFS Gateway → Filecoin Pin
```

### How It Works

1. **Push Flow**: When you `docker push` to PinCeR:
   - PinCeR receives manifest and layer blobs via standard OCI API
   - Uploads content to Filecoin Pin and gets IPFS CIDs
   - Automatically maps `image:tag` → IPFS CIDs
   - No manual configuration needed

2. **Pull Flow**: When you `docker pull` from PinCeR:
   - PinCeR looks up `image:tag` → IPFS CID mapping
   - Fetches manifest and layers from IPFS gateways
   - Serves content with proper OCI headers
   - Works exactly like any other registry

## Installation

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start the server
npm start

# Or run in development mode (with auto-reload)
npm run dev
```

## Configuration

PinCeR can be configured via environment variables:

- `PINCER_MAPPING_FILE`: Path to image mapping JSON file (default: `image_mapping.json`)
- `PINCER_STORAGE_DIR`: Directory for staging blobs during upload (default: `storage`)
- `PINCER_HOST`: Server host (default: `0.0.0.0`)
- `PINCER_PORT`: Server port (default: `5002` - changed from 5000 to avoid macOS Control Center conflict)

## Usage

### 1. Start the Server

```bash
npm start
```

Or in development mode:

```bash
npm run dev
```

### 2. Build and Push Images

Use standard Docker/OCI tools - no special configuration needed:

```bash
# Build your image (using port 5002, or set PINCER_PORT environment variable)
docker build -t localhost:5002/myapp:latest .

# Push to PinCeR (PinCeR automatically uploads to Filecoin Pin)
docker push localhost:5002/myapp:latest
```

When you push:
- PinCeR receives the manifest and layers via standard OCI API
- Automatically uploads content to Filecoin Pin
- Stores IPFS CIDs in the mapping file
- No manual steps required!

### 3. Pull Images

Pull images normally - PinCeR fetches from IPFS automatically:

```bash
# Pull from PinCeR
docker pull localhost:5002/myapp:latest

# Run the container
docker run localhost:5002/myapp:latest
```

### 4. Configure Docker/containerd (Optional)

For production use, configure your container runtime:

```bash
# Docker: Add to /etc/docker/daemon.json
{
  "insecure-registries": ["localhost:5002"]
}

# Kubernetes/containerd: Add to /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".registry.mirrors]
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:5002"]
    endpoint = ["http://localhost:5002"]
```

## Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

### Self-Containerization Test

PinCeR includes a meta test that builds PinCeR itself as a Docker image and pushes it to its own registry! This demonstrates the full push/pull cycle:

```bash
npm test -- tests/integration.test.ts
```

**⚠️ Docker Configuration Required**: This test requires Docker to be configured for insecure registries. See [DOCKER_CONFIG.md](./DOCKER_CONFIG.md) for detailed instructions.

**Quick setup for Docker Desktop (macOS/Windows)**:
1. Open Docker Desktop → **Settings** → **Docker Engine**
2. Add to the JSON configuration:
   ```json
   {
     "insecure-registries": ["localhost:5001"]
   }
   ```
   (Note: Test uses port 5001, main server uses 5002 by default)
3. Click **Apply & Restart**

**Linux**: Add to `/etc/docker/daemon.json`:
```json
{
  "insecure-registries": ["localhost:5001", "localhost:5002"]
}
```
Then restart: `sudo systemctl restart docker`

## Project Structure

```
pincer/
├── src/
│   ├── index.ts          # Express server (main entry point)
│   ├── config.ts         # Configuration management
│   ├── mapping.ts        # Image→CID mapping system
│   ├── storage.ts        # Blob storage (staging for Filecoin Pin)
│   ├── ipfs.ts           # IPFS fetching utilities
│   └── utils.ts          # OCI utility functions
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Node.js dependencies
├── tsconfig.json         # TypeScript configuration
└── README.md             # This file
```

## How It Works Internally

When you push an image:

1. **Blob Upload**: Docker uploads each layer blob via `POST /v2/{name}/blobs/uploads/`
2. **Filecoin Pin**: PinCeR uploads the blob to Filecoin Pin and receives an IPFS CID
3. **Mapping Storage**: PinCeR stores `digest → IPFS CID` mapping
4. **Manifest Upload**: Docker uploads the manifest via `PUT /v2/{name}/manifests/{reference}`
5. **Manifest Pin**: PinCeR uploads manifest to Filecoin Pin
6. **Tag Mapping**: PinCeR stores `image:tag → manifest IPFS CID` mapping

When you pull an image:

1. **Tag Lookup**: PinCeR looks up `image:tag` → manifest IPFS CID
2. **Manifest Fetch**: Retrieves manifest from IPFS gateway
3. **Layer Resolution**: Maps layer digests → IPFS CIDs from stored mappings
4. **Layer Streaming**: Streams layers from IPFS gateways
5. **Standard Response**: Serves content with proper OCI headers

## Limitations

- **Filecoin Pin Integration**: Currently uses placeholder for Filecoin Pin uploads (to be implemented)
- **No authentication**: Doesn't implement registry authentication (can be added)
- **Single gateway**: Uses one IPFS gateway at a time (can be extended for failover)

## Future Improvements

- [ ] Complete Filecoin Pin API integration
- [ ] Support for multiple IPFS gateways with failover
- [ ] Authentication support (Docker registry auth)
- [ ] Caching layer for faster pulls
- [ ] Health checks and metrics
- [ ] Support for manifest lists (multi-arch images)
- [ ] Repository and tag listing endpoints (`GET /v2/_catalog`, `GET /v2/{name}/tags/list`)

## License

MIT License - see LICENSE file for details.
