# PinCeR

🦞 **PinCeR** (Pincer) is a full OCI Container Registry that stores images in Filecoin Pin/IPFS. Use standard Docker/containerd tools to push and pull images - PinCeR handles all the Filecoin Pin integration transparently.

## Features

- ✅ **Full OCI Distribution Spec** - Supports both push and pull operations
- ✅ **Standard Docker/containerd tools** - Works with `docker login`, `docker push/pull`, etc.
- ✅ **Automatic Filecoin Pin integration** - Images are automatically uploaded to Filecoin Pin when pushed
- ✅ **IPFS-backed storage** - Stored layers can be served via IPFS gateways
- ✅ **Zero user changes** - Push and pull images normally, PinCeR handles all the Filecoin specifics

## Architecture

PinCeR implements the full OCI Distribution Spec HTTP API, acting as a transparent proxy to Filecoin Pin:

```
Push:  Docker/containerd → PinCeR → Filecoin Pin → IPFS
Pull:  Docker/containerd → PinCeR → IPFS Gateway → Filecoin Pin
```

### How It Works

1. **Push Flow**: When you `docker push` to PinCeR:
   - PinCeR receives manifest and layer blobs via standard OCI API
   - Stores a temporary staging local copy and deals with mappings, CIDs etc
   - Uploads content to Filecoin Pin and gets back final IPFS CIDs
   - **Note** uploading large layers to Filecoin Pin takes longer than the docker timeout, so jobs complete asynchronously

2. **Pull Flow**: When you `docker pull` from PinCeR:
   - PinCeR looks up `image:tag` → IPFS CID mapping
   - Fetches manifest and layers from IPFS gateways
   - Serves content with proper OCI headers like any other registry

## Installation

### Prerequisites

- Node.js 20+ 
- npm or yarn

### Setup

## Configuration

PinCeR can be configured via environment variables:

- `PINCER_MAPPING_FILE`: Path to image mapping JSON file (default: `image_mapping.json`)
- `PINCER_STORAGE_DIR`: Directory for staging blobs during upload (default: `storage`)
- `PINCER_HOST`: Server host (default: `0.0.0.0`)
- `PINCER_PORT`: Server port (default: `5002` - changed from 5000 to avoid macOS Control Center conflict)
- `PINCER_RPC_URL`: Filecoin RPC URL (optional, defaults to calibration testnet)
- `PINCER_WARM_STORAGE_ADDRESS`: WarmStorage contract address (optional, uses SDK default for network)
- `PINCER_DATASET_ID`: Explicitly specify which Synapse dataset ID to use (optional, defaults to SDK auto-selection)

### Dataset Selection

**By default, PinCeR creates a new dataset for each image you push.** This ensures each image (manifest + all layers) is self-contained in its own dataset, making it easy to:
- Organize images independently
- See what belongs to each image
- Manage/delete images as units

Each `docker push` will create a new dataset, and all blobs and the manifest for that image will be uploaded to that dataset.

If you prefer clustered behavior (one dataset per user), you can set `PINCER_DATASET_ID` to use a specific dataset for all uploads:

```bash
# Use dataset ID 127 for all uploads (legacy behavior)
PINCER_DATASET_ID=127 npm start
```

## Usage

### 1. Start the Server

```bash
npm start
```

Or in development mode:

```bash
npm run dev
```

### 2. Authenticate with Docker

PinCeR requires authentication for push operations (pull can be public or authenticated). Use your Ethereum private key:

```bash
# Login with your Fielcoin Pin private key (password is your private key)
docker login localhost:5002 -u myuser -p 0x1234567890abcdef...
```

**Note**: The private key can be provided with or without the `0x` prefix - PinCeR will normalize it automatically.
**Note**: Use use --password-stdin for more secure ways of providing the private key

### 3. Build and Push Images

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

### 4. Configure Docker/containerd

⚠️ **WARNING** At the moment PinCeR only runs as a local proxy over HTTP so it has to be added to `insecure-registries`. If you host yours somewhere with TLS then this step won't be necessary.

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

### Getting a wallet

If you don't have a wallet/private key to use with Filecoin Pin you can make one easily with Foundry:

```bash
$cast wallet new

Successfully created new keypair.
Address:     0x<hex of the wallet address - use this at faucets and in transactions>
Private key: 0x<hex of private key - keep this safe and use with 'docker login' or Synapse init>
```

### Funding your wallet

1. Get funds and get an ActorID for your wallet (calibnet): https://beryx.io/faucet
2. Get USDFC: https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc
3. Move USDFC to the payment contract:

Filecoin Pin requires an amount of setup for your wallet to work. A utility is provided to make this easier:

```bash
# One time authorise the contract and move USDFC funds from the wallet to WarmStorgae
APPROVE_SERVICE=true DEPOSIT_AMOUNT=5 npm run tools:deposit

# Subsequent times just move USDFC funds
DEPOSIT_AMOUNT=5 npm run tools:deposit

# Or just check your balances
npm run tools:deposit
```

### Self-Containerization Test

PinCeR includes a meta test that builds PinCeR itself as a Docker image and pushes it to its own registry! This demonstrates the full push/pull cycle:

```bash
# Set your private key (merges `docker login` with Synapse private key auth)
export TEST_PRIVATE_KEY=0x1234567890abcdef...

# Run the integration test
npm test -- tests/integration.test.ts
```

**⚠️ Requirements**:
- **TEST_PRIVATE_KEY**: Set this environment variable with your Ethereum private key (with or without `0x` prefix). This key must have USDFC (USD Filecoin) for Synapse operations.
- **Docker Configuration**: Docker must be configured for insecure registries. See above.

**Note**: The test will skip if `TEST_PRIVATE_KEY` is not set, with a helpful warning message.


## License

MIT License - see LICENSE file for details.
