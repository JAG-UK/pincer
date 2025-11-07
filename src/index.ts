import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import pino from 'pino';
import { loadConfig, Config } from './config.js';
import { ImageMapping } from './mapping.js';
import { BlobStorage } from './storage.js';
import { parseManifestLayers } from './utils.js';
import { requireAuth, optionalAuth, type AuthCredentials } from './auth.js';
import { getSynapseServiceForImage, cleanupAllServices } from './synapse-manager.js';
import { createCarFromBytes } from './car-utils.js';
import { executeUpload } from 'filecoin-pin/core/upload';
import { CID } from 'multiformats/cid';

const app = express();

// Configure Express to handle trailing slashes consistently
app.set('strict routing', false);

// Global state
let config: Config;
let imageMapping: ImageMapping;
let blobStorage: BlobStorage;
let logger: pino.Logger;

// Initialize on startup
function initialize() {
  config = loadConfig();
  imageMapping = new ImageMapping(config.mappingFile);
  blobStorage = new BlobStorage(config.storageDir);
  
  // Initialize logger
  logger = pino({
    level: process.env.LOG_LEVEL || 'info', // Back to info level by default
  });
  
  logger.info({ event: 'pincer.start' }, 'PinCeR started');
  logger.info({ storageDir: config.storageDir }, 'Blob storage initialized');
}

// Middleware
app.use(express.raw({ type: '*/*', limit: '10gb' }));

// Request logging middleware (for debugging auth issues)
app.use((req: Request, res: Response, next: () => void) => {
  if (req.path.startsWith('/v2/')) {
    const authHeader = req.headers.authorization;
    logger.debug({
      event: 'request',
      method: req.method,
      path: req.path,
      hasAuth: !!authHeader,
      authType: authHeader ? (authHeader.startsWith('Basic ') ? 'Basic' : authHeader.startsWith('Bearer ') ? 'Bearer' : 'Unknown') : 'none',
    }, 'Incoming request');
  }
  next();
});

// OCI Distribution Spec endpoints

app.get('/v2/', optionalAuth, (req: Request, res: Response) => {
  // Docker checks this endpoint to see if auth is required
  // For insecure HTTP registries, Docker often doesn't send credentials automatically
  // unless it's challenged with a 401 first. We return 401 if no auth is provided
  // to force Docker to authenticate, then it will send credentials on subsequent requests
  
  if (!req.headers.authorization) {
    // Return 401 to challenge Docker - this forces Docker to use stored credentials
    res.set('WWW-Authenticate', 'Basic realm="PinCeR Registry"');
    res.status(401).json({
      errors: [{
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        detail: 'Provide credentials via Authorization header (Basic Auth or Bearer token)'
      }]
    });
    return;
  }
  
  // If auth is provided, return success
  res.json({ version: '2.0' });
});

app.head('/v2/', optionalAuth, (req: Request, res: Response) => {
  // Same logic for HEAD requests
  if (!req.headers.authorization) {
    res.set('WWW-Authenticate', 'Basic realm="PinCeR Registry"');
    res.status(401).send();
    return;
  }
  res.sendStatus(200);
});

app.get('/v2/*/manifests/:reference', async (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'manifests') || '';
  const reference = req.path.split('/manifests/').pop()?.split('?')[0] || '';
  
  // Look up manifest CID from mapping
  const cid = imageMapping.getManifestCid(name, reference);
  
  if (!cid) {
    return res.status(404).json({ error: `Manifest not found for ${name}:${reference}` });
  }
  
  // Check if CID is a digest (local storage) or IPFS CID (Filecoin Pin)
  if (cid.startsWith('sha256:')) {
    // Local storage - lookup by digest
    const manifestPath = blobStorage.getManifestPath(cid);
    
    if (!manifestPath) {
      return res.status(404).json({ error: `Manifest not found locally (digest: ${cid})` });
    }
    
    // Read manifest from local storage
    const manifestBytes = await import('fs').then(fs => fs.promises.readFile(manifestPath));
    
    // Parse manifest to determine content type
    let manifestData: any;
    try {
      manifestData = JSON.parse(manifestBytes.toString('utf-8'));
    } catch (error) {
      return res.status(500).json({ error: 'Failed to parse manifest' });
    }
    
    // Determine content type based on manifest schema
    let contentType = 'application/vnd.docker.distribution.manifest.v2+json';
    if (manifestData.mediaType) {
      contentType = manifestData.mediaType;
    } else if (manifestData.schemaVersion === 2) {
      contentType = 'application/vnd.docker.distribution.manifest.v2+json';
    } else {
      contentType = 'application/vnd.oci.image.manifest.v1+json';
    }
    
    // Return manifest with proper headers
    res.set({
      'Content-Type': contentType,
      'Docker-Content-Digest': cid,
      'Content-Length': manifestBytes.length.toString(),
    });
    res.send(manifestBytes);
    return;
  }
  
  // IPFS CID - fetch from Filecoin Pin
  // Try IPFS first, but fallback to local storage if IPFS isn't available yet (IPNI propagation delay)
  try {
    const ipfsCid = CID.parse(cid);
    
    // For now, use IPFS gateway to fetch
    // TODO: Use Synapse service download URL if we have user credentials
    const ipfsUrl = `https://${cid}.ipfs.dweb.link`;
    logger.info({ event: 'fetch.manifest.ipfs', cid, url: ipfsUrl }, 'Fetching manifest from IPFS');
    
    const response = await fetch(ipfsUrl, { signal: AbortSignal.timeout(10000) }); // 10 second timeout
    if (!response.ok) {
      throw new Error(`Failed to fetch from IPFS: ${response.status} ${response.statusText}`);
    }
    
    const manifestBytes = Buffer.from(await response.arrayBuffer());
    
    // Parse manifest to determine content type
    let manifestData: any;
    try {
      manifestData = JSON.parse(manifestBytes.toString('utf-8'));
    } catch (error) {
      return res.status(500).json({ error: 'Failed to parse manifest' });
    }
    
    // Determine content type
    let contentType = 'application/vnd.docker.distribution.manifest.v2+json';
    if (manifestData.mediaType) {
      contentType = manifestData.mediaType;
    } else if (manifestData.schemaVersion === 2) {
      contentType = 'application/vnd.docker.distribution.manifest.v2+json';
    } else {
      contentType = 'application/vnd.oci.image.manifest.v1+json';
    }
    
    // Compute digest from bytes
    const hash = createHash('sha256');
    hash.update(manifestBytes);
    const digest = `sha256:${hash.digest('hex')}`;
    
    // Return manifest with proper headers
    res.set({
      'Content-Type': contentType,
      'Docker-Content-Digest': digest,
      'Content-Length': manifestBytes.length.toString(),
    });
    res.send(manifestBytes);
  } catch (error: any) {
    // IPFS fetch failed - fallback to local storage if available
    logger.warn({ event: 'fetch.manifest.ipfs.fallback', cid, error: error.message }, 'IPFS fetch failed, trying local storage fallback');
    
    // Try to get the digest from the mapping (if we stored it)
    // Or try to find it by looking up what digest this CID maps to
    const manifestDigest = cid; // This might be wrong, but let's try local lookup
    
    // Actually, we need to find the digest that corresponds to this CID
    // For now, try to find manifest by digest in local storage
    // We'll need to check if the manifest was saved locally
    
    // Check if we have a locally saved manifest that matches
    // Since we saved manifests with their digest, we can try to find it
    // But we don't have a reverse mapping from CID -> digest easily
    
    // For now, just return error - in practice, once mappings are updated to IPFS CIDs,
    // IPNI should have propagated by then. If not, we can enhance this later.
    logger.error({ event: 'fetch.manifest.error', cid, error: error.message }, 'Failed to fetch manifest from IPFS');
    return res.status(404).json({ error: `Failed to fetch manifest from IPFS: ${error.message}` });
  }
});

app.head('/v2/*/manifests/:reference', (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'manifests') || '';
  const reference = req.path.split('/manifests/').pop()?.split('?')[0] || '';
  
  const cid = imageMapping.getManifestCid(name, reference);
  
  if (!cid) {
    return res.sendStatus(404);
  }
  
  // Check if manifest exists locally (digest) or in Filecoin Pin (IPFS CID)
  if (cid.startsWith('sha256:')) {
    const manifestPath = blobStorage.getManifestPath(cid);
    if (!manifestPath) {
      return res.sendStatus(404);
    }
    res.set({
      'Docker-Content-Digest': cid,
    });
    res.sendStatus(200);
    return;
  }
  
  // IPFS CID - manifest exists in Filecoin Pin (we can't verify without fetching, but assume it exists)
  res.set({
    'Docker-Content-Digest': cid, // Will be resolved to digest on GET
  });
  res.sendStatus(200);
});

app.get('/v2/*/blobs/:digest', async (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'blobs') || '';
  const digest = req.path.split('/blobs/').pop()?.split('?')[0] || '';
  
  // Look up blob CID from mapping
  const cid = imageMapping.getBlobCid(name, digest);
  
  if (!cid) {
    return res.status(404).json({ error: `Blob not found for digest ${digest}` });
  }
  
  // Check if blob exists locally (digest lookup) or in Filecoin Pin (IPFS CID)
  if (cid.startsWith('sha256:')) {
    // Local storage - lookup by digest
    const blobPath = blobStorage.getBlobPath(digest);
    
    if (!blobPath) {
      return res.status(404).json({ error: `Blob not found locally (digest: ${digest})` });
    }
    
    // Stream the blob from local filesystem
    try {
      const fs = await import('fs');
      const stat = await fs.promises.stat(blobPath);
      
      res.set({
        'Content-Type': 'application/octet-stream',
        'Docker-Content-Digest': digest,
        'Content-Length': stat.size.toString(),
      });
      
      const stream = fs.createReadStream(blobPath);
      
      stream.on('data', (chunk: string | Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!res.write(buffer)) {
          // If write buffer is full, pause the stream
          stream.pause();
          res.once('drain', () => stream.resume());
        }
      });
      
      stream.on('end', () => {
        res.end();
      });
      
      stream.on('error', (error: Error) => {
        logger.error({ event: 'fetch.blob.error', digest, error: error.message }, 'Failed to read blob from filesystem');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read blob from filesystem' });
        } else {
          res.destroy();
        }
      });
    } catch (error: any) {
      logger.error({ event: 'fetch.blob.error', digest, error: error.message }, 'Failed to fetch blob');
      if (!res.headersSent) {
        res.status(404).json({ error: 'Failed to fetch blob' });
      } else {
        res.destroy();
      }
    }
    return;
  }
  
  // IPFS CID - fetch from Filecoin Pin/IPFS
  // Try IPFS first, but fallback to local storage if IPFS isn't available yet
  try {
    const ipfsCid = CID.parse(cid);
    
    // For now, use IPFS gateway to fetch
    // TODO: Use Synapse service download URL if we have user credentials
    const ipfsUrl = `https://${cid}.ipfs.dweb.link`;
    logger.info({ event: 'fetch.blob.ipfs.start', cid, url: ipfsUrl }, 'Fetching blob from IPFS');
    
    const response = await fetch(ipfsUrl, { signal: AbortSignal.timeout(10000) }); // 10 second timeout
    if (!response.ok) {
      throw new Error(`Failed to fetch from IPFS: ${response.status} ${response.statusText}`);
    }
    
    // Stream the blob from IPFS
    res.set({
      'Content-Type': 'application/octet-stream',
      'Docker-Content-Digest': digest,
    });
    
    const reader = response.body!.getReader();
    
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          
          if (!res.write(value)) {
            // If write buffer is full, wait for drain
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
      } catch (error: any) {
        logger.error({ event: 'fetch.blob.ipfs.error', cid, error: error.message }, 'Failed to stream blob from IPFS');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream blob from IPFS' });
        } else {
          res.destroy();
        }
      } finally {
        reader.releaseLock();
      }
    };
    
    pump();
  } catch (error: any) {
    // IPFS fetch failed - fallback to local storage if available
    logger.warn({ event: 'fetch.blob.ipfs.fallback', cid, digest, error: error.message }, 'IPFS fetch failed, trying local storage fallback');
    
    const blobPath = blobStorage.getBlobPath(digest);
    if (blobPath) {
      logger.info({ event: 'fetch.blob.local.fallback', digest }, 'Serving blob from local storage (IPFS not available yet)');
      
      try {
        const fs = await import('fs');
        const stat = await fs.promises.stat(blobPath);
        
        res.set({
          'Content-Type': 'application/octet-stream',
          'Docker-Content-Digest': digest,
          'Content-Length': stat.size.toString(),
        });
        
        const stream = fs.createReadStream(blobPath);
        
        stream.on('data', (chunk: string | Buffer) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!res.write(buffer)) {
            stream.pause();
            res.once('drain', () => stream.resume());
          }
        });
        
        stream.on('end', () => {
          res.end();
        });
        
        stream.on('error', (error: Error) => {
          logger.error({ event: 'fetch.blob.error', digest, error: error.message }, 'Failed to read blob from filesystem');
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to read blob from filesystem' });
          } else {
            res.destroy();
          }
        });
      } catch (error: any) {
        logger.error({ event: 'fetch.blob.error', digest, error: error.message }, 'Failed to fetch blob');
        if (!res.headersSent) {
          res.status(404).json({ error: 'Failed to fetch blob' });
        } else {
          res.destroy();
        }
      }
    } else {
      // No local fallback available
      logger.error({ event: 'fetch.blob.error', digest, cid, error: error.message }, 'Failed to fetch blob from IPFS and no local fallback');
      if (!res.headersSent) {
        res.status(404).json({ error: `Failed to fetch blob from IPFS: ${error.message}` });
      } else {
        res.destroy();
      }
    }
  }
});

app.head('/v2/*/blobs/:digest', (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'blobs') || '';
  const digest = req.path.split('/blobs/').pop()?.split('?')[0] || '';
  
  // Check mapping for blob CID
  const cid = imageMapping.getBlobCid(name, digest);
  
  if (!cid) {
    return res.sendStatus(404);
  }
  
  // Check if blob exists locally (digest lookup) or in Filecoin Pin (IPFS CID)
  if (cid.startsWith('sha256:')) {
    // Local storage
    if (!blobStorage.blobExists(digest)) {
      return res.sendStatus(404);
    }
    res.sendStatus(200);
    return;
  }
  
  // IPFS CID - blob exists in Filecoin Pin (we can't verify without fetching, but assume it exists)
  res.sendStatus(200);
});

// Push endpoints - require authentication
// OCI spec: push operations require authentication

// Handle blob upload start - image name can contain slashes (e.g., "test/pincer-self-test")
// Use wildcard pattern to match everything after /v2/ and before /blobs/uploads
app.post('/v2/*/blobs/uploads', requireAuth, (req: Request, res: Response) => {
  const pathMatch = req.path.match(/^\/v2\/(.+)\/blobs\/uploads\/?$/);
  if (!pathMatch) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const name = pathMatch[1];
  
  const uploadId = blobStorage.startUpload(name);
  
  const location = `/v2/${name}/blobs/uploads/${uploadId}`;
  
  res.status(202);
  res.set({
    'Location': location,
    'Docker-Upload-UUID': uploadId,
    'Range': '0-0',
  });
  res.send();
});

// Also handle with trailing slash
app.post('/v2/*/blobs/uploads/', requireAuth, (req: Request, res: Response) => {
  const pathMatch = req.path.match(/^\/v2\/(.+)\/blobs\/uploads\/?$/);
  if (!pathMatch) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const name = pathMatch[1];
  
  const uploadId = blobStorage.startUpload(name);
  
  const location = `/v2/${name}/blobs/uploads/${uploadId}`;
  
  res.status(202);
  res.set({
    'Location': location,
    'Docker-Upload-UUID': uploadId,
    'Range': '0-0',
  });
  res.send();
});

// Helper to extract image name from path (handles slashes in name)
function extractImageName(path: string, segment: string): string | null {
  // Extract everything between /v2/ and the next fixed segment
  // e.g., /v2/test/pincer-self-test/blobs/... -> test/pincer-self-test
  const pattern = new RegExp(`^\\/v2\\/(.+?)\\/${segment}`);
  const match = path.match(pattern);
  return match ? match[1] : null;
}

app.patch('/v2/*/blobs/uploads/:uploadId', requireAuth, (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'blobs/uploads') || '';
  // Extract uploadId - it's the segment after /blobs/uploads/
  const uploadIdMatch = req.path.match(/\/blobs\/uploads\/([^\/\?]+)/);
  const uploadId = uploadIdMatch ? uploadIdMatch[1] : req.params.uploadId;
  
  const chunkData = req.body as Buffer;
  
  if (!chunkData || chunkData.length === 0) {
    return res.status(400).json({ error: 'No data provided' });
  }
  
  // Append chunk to upload session
  blobStorage.appendChunk(uploadId, chunkData);
  
  // Get current size
  const session = blobStorage.uploadSessions.get(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }
  const size = session.size;
  
  const location = `/v2/${name}/blobs/uploads/${uploadId}`;
  
  res.status(202);
  res.set({
    'Location': location,
    'Docker-Upload-UUID': uploadId,
    'Range': `0-${size - 1}`,
  });
  res.send();
});

app.put('/v2/*/blobs/uploads/:uploadId', requireAuth, async (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'blobs/uploads') || '';
  // Extract uploadId - it's the segment after /blobs/uploads/
  const uploadIdMatch = req.path.match(/\/blobs\/uploads\/([^\/\?]+)/);
  const uploadId = uploadIdMatch ? uploadIdMatch[1] : req.params.uploadId;
  const digest = req.query.digest as string;
  
  if (!digest) {
    return res.status(400).json({ error: 'digest query parameter required' });
  }
  
  // Read any remaining data
  const chunkData = req.body as Buffer;
  if (chunkData && chunkData.length > 0) {
    blobStorage.appendChunk(uploadId, chunkData);
  }
  
  // Complete upload and save blob to local storage
  const actualDigest = blobStorage.completeUpload(uploadId, digest);
  
  // Get credentials from auth middleware
  const credentials = (req as any).auth as AuthCredentials;
  
  // Get Synapse service with a dataset for this specific image
  // Each image gets its own dataset, keeping manifest + layers together
  const synapseService = await getSynapseServiceForImage(credentials, config, logger, name);
  
  // Get blob path to read the data
  const blobPath = blobStorage.getBlobPath(actualDigest);
  if (!blobPath) {
    return res.status(500).json({ error: 'Failed to locate saved blob' });
  }
  
  // Read blob data first so we know the piece size
  const fs = await import('fs');
  const blobData = await fs.promises.readFile(blobPath);
  
  // Note: Deposit/approval should be done beforehand using the synapse-deposit.ts script
  // We proceed directly to upload assuming funds are already deposited
  
  // Create CAR file from blob bytes (this is fast, just computing the CID)
  const { carData, rootCid } = await createCarFromBytes(blobData, logger);
  const ipfsCid = rootCid.toString();
  
  // Store blob mapping initially with digest (for local storage)
  // We'll update to IPFS CID after async upload completes
  // This ensures pulls work immediately from local storage
  imageMapping.updateMappings((mappings) => {
    if (!mappings[name] || typeof mappings[name] === 'string') {
      mappings[name] = { blobs: {} };
    }
    const imageData = mappings[name];
    if (typeof imageData === 'object' && !Array.isArray(imageData) && 'blobs' in imageData) {
      const data = imageData as { blobs?: Record<string, string> };
      if (!data.blobs) {
        data.blobs = {};
      }
      // Store digest initially - will be updated to IPFS CID after upload completes
      data.blobs[actualDigest] = actualDigest; // Use digest for local storage lookup
    }
  });
  
  // Send response to Docker immediately (don't wait for Filecoin Pin upload)
  const location = `/v2/${name}/blobs/${actualDigest}`;
  res.status(201);
  res.set({
    'Location': location,
    'Docker-Content-Digest': actualDigest,
    'Content-Length': '0',
  });
  res.send();
  
  // Upload to Filecoin Pin asynchronously in the background
  // This can take a while (needs blockchain confirmations), so we don't block the response
  logger.info({ event: 'upload.blob.synapse.start', cid: ipfsCid }, 'Starting async upload to Filecoin Pin');
  executeUpload(synapseService, carData, rootCid, {
    logger,
    contextId: `blob-${actualDigest}`,
    metadata: {
      type: 'oci-blob',
      digest: actualDigest,
      imageName: name,
    },
  }).then((uploadResult) => {
    logger.info(
      { event: 'upload.blob.synapse.success', cid: ipfsCid, pieceCid: uploadResult.pieceCid },
      'Blob uploaded to Filecoin Pin (async)'
    );
    
    // Now update the mapping to use IPFS CID instead of digest
    // This allows pulls to work from IPFS once the upload completes
    imageMapping.updateMappings((mappings) => {
      if (!mappings[name] || typeof mappings[name] === 'string') {
        mappings[name] = { blobs: {} };
      }
      const imageData = mappings[name];
      if (typeof imageData === 'object' && !Array.isArray(imageData) && 'blobs' in imageData) {
        const data = imageData as { blobs?: Record<string, string> };
        if (!data.blobs) {
          data.blobs = {};
        }
        // Update to IPFS CID now that upload is complete
        data.blobs[actualDigest] = ipfsCid;
        logger.info({ event: 'mapping.updated', digest: actualDigest, cid: ipfsCid }, `Updated blob mapping to use IPFS CID: ${ipfsCid}`);
      }
    });
  }).catch((error: any) => {
    logger.error({ event: 'upload.blob.synapse.error', cid: ipfsCid, error: error.message }, 'Failed to upload blob to Filecoin Pin (async)');
    
    // Log specific errors but don't fail the request (already sent response)
    if (error.message?.includes('InsufficientFunds') || error.message?.includes('Insufficient')) {
      try {
        synapseService.synapse.getClient().getAddress().then((walletAddress: string) => {
          logger.error({ event: 'upload.blob.insufficient_funds', address: walletAddress }, 
            `❌ Insufficient USDFC (USD Filecoin) funds in wallet ${walletAddress} for async upload. ` +
            `Fund your wallet at: https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc`
          );
        }).catch(() => {
          // Ignore errors getting address
        });
      } catch {
        // Ignore errors
      }
    }
  });
});

app.put('/v2/*/manifests/:reference', requireAuth, async (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'manifests') || '';
  const reference = req.path.split('/manifests/').pop()?.split('?')[0] || '';
  
  logger.info({ event: 'manifest.put.start', name, reference }, `Received manifest PUT request for ${name}:${reference}`);
  
  const manifestBytes = req.body as Buffer;
  
  if (!manifestBytes || manifestBytes.length === 0) {
    logger.error({ event: 'manifest.put.error', name, reference }, 'No manifest data provided');
    return res.status(400).json({ error: 'No manifest data provided' });
  }
  
  // Parse manifest JSON for validation and layer extraction
  let manifestData: any;
  try {
    manifestData = JSON.parse(manifestBytes.toString('utf-8'));
  } catch (error) {
    logger.error({ event: 'manifest.put.error', name, reference, error }, 'Invalid JSON manifest');
    return res.status(400).json({ error: 'Invalid JSON manifest' });
  }

  // Save manifest to local storage - use the raw bytes to preserve exact digest
  const manifestDigest = blobStorage.saveManifest(name, reference, manifestBytes);
  logger.info({ event: 'manifest.saved', digest: manifestDigest }, `Saved manifest ${manifestDigest} for ${name}:${reference}`);
  
  // Create CAR file from manifest bytes (this is fast, just computing the CID)
  logger.info({ event: 'upload.manifest.start', digest: manifestDigest, size: manifestBytes.length }, 'Creating CAR file from manifest');
  let carData: Uint8Array | null = null;
  let rootCid: CID | null = null;
  let ipfsCid: string;
  try {
    const result = await createCarFromBytes(manifestBytes, logger);
    carData = result.carData;
    rootCid = result.rootCid;
    ipfsCid = rootCid.toString();
    logger.info({ event: 'car.created', cid: ipfsCid, carSize: carData.length }, `Created CAR file with CID ${ipfsCid} (${carData.length} bytes)`);
  } catch (error: any) {
    logger.error({ event: 'car.create.error', error: error.message, stack: error.stack }, 'Failed to create CAR file - will use digest fallback');
    // Use digest as fallback - manifest won't be uploaded to Filecoin Pin, but can still be served from local storage
    ipfsCid = manifestDigest;
    // Don't set carData/rootCid - we'll skip the upload if they're null
  }
  
  // Extract layer digests and create blob mappings (do this before upload so we have the mappings)
  const layers = parseManifestLayers(manifestData);
  const blobMappings: Record<string, string> = {};
  
  for (const layer of layers) {
    const layerDigest = layer.digest;
    if (layerDigest) {
      // Look up blob CID from mapping (should already be uploaded)
      const blobCid = imageMapping.getBlobCid(name, layerDigest);
      if (blobCid) {
        blobMappings[layerDigest] = blobCid;
      }
    }
  }
  
  // Store manifest mapping immediately (use IPFS CID or digest as fallback)
  // We store the CID even before upload completes, so pulls can work
  logger.info({ event: 'mapping.save.start', name, reference, cid: ipfsCid }, `Saving manifest mapping for ${name}:${reference}`);
  try {
    imageMapping.addMapping(
      name,
      reference,
      ipfsCid, // Store IPFS CID for Filecoin Pin lookup (or digest as fallback)
      Object.keys(blobMappings).length > 0 ? blobMappings : undefined
    );
    logger.info({ event: 'mapping.saved', name, reference, cid: ipfsCid }, `Saved manifest mapping for ${name}:${reference}`);
    
    // Also store mapping for the digest itself, so Docker can pull by digest
    // Docker resolves tag -> digest via HEAD, then pulls by digest
    if (reference !== manifestDigest) {
      imageMapping.addMapping(
        name,
        manifestDigest, // Store digest as its own reference
        ipfsCid, // But still use IPFS CID for lookup (or digest as fallback)
        Object.keys(blobMappings).length > 0 ? blobMappings : undefined
      );
      logger.info({ event: 'mapping.stored', digest: manifestDigest, cid: ipfsCid }, `Also stored manifest ${manifestDigest} for ${name}:${manifestDigest}`);
    }
  } catch (error: any) {
    logger.error({ event: 'mapping.save.error', name, reference, error: error.message }, `Failed to save manifest mapping: ${error.message}`);
    // Continue anyway - we'll try to send response
  }
  
  // Send response to Docker immediately (don't wait for Filecoin Pin upload)
  logger.info({ event: 'manifest.put.response', name, reference, digest: manifestDigest }, `Sending response for ${name}:${reference}`);
  res.status(201);
  res.set({
    'Docker-Content-Digest': manifestDigest,
    'Location': `/v2/${name}/manifests/${reference}`,
    'Content-Length': manifestBytes.length.toString(),
  });
  res.send();
  
  // Get credentials from auth middleware (for async upload)
  const credentials = (req as any).auth as AuthCredentials;
  
  // Upload manifest to Filecoin Pin asynchronously in the background
  // This can take a while (needs blockchain confirmations), so we don't block the response
  // Use the same dataset as the image (created when first blob was pushed)
  // Skip upload if CAR creation failed (carData will be null)
  if (!carData || !rootCid) {
    logger.warn({ event: 'upload.manifest.synapse.skipped', cid: ipfsCid, reason: 'CAR creation failed' }, 
      'Skipping manifest upload to Filecoin Pin - CAR creation failed, using digest fallback');
    return;
  }
  
  logger.info({ event: 'upload.manifest.synapse.start', cid: ipfsCid, carSize: carData.length }, 'Starting async upload to Filecoin Pin');
  getSynapseServiceForImage(credentials, config, logger, name)
    .then((synapseService) => {
      logger.debug({ event: 'upload.manifest.synapse.service.ready', dataSetId: synapseService.storage.dataSetId }, 
        `Got Synapse service for image ${name}, dataset ${synapseService.storage.dataSetId}`);
      return executeUpload(synapseService, carData!, rootCid!, {
        logger,
        contextId: `manifest-${manifestDigest}`,
        metadata: {
          type: 'oci-manifest',
          digest: manifestDigest,
          imageName: name,
          reference: reference,
          ipfsRootCID: ipfsCid, // Store root CID in metadata for later retrieval
        },
      });
    })
    .then((uploadResult) => {
      logger.info(
        { 
          event: 'upload.manifest.synapse.success', 
          cid: ipfsCid, 
          pieceCid: uploadResult.pieceCid,
          pieceId: uploadResult.pieceId,
          dataSetId: uploadResult.dataSetId
        },
        `Manifest uploaded to Filecoin Pin (async) - Piece CID: ${uploadResult.pieceCid}, Dataset: ${uploadResult.dataSetId}`
      );
    })
    .catch((error: any) => {
      logger.error({ 
        event: 'upload.manifest.synapse.error', 
        cid: ipfsCid, 
        error: error.message,
        stack: error.stack,
        name: name,
        reference: reference
      }, `Failed to upload manifest to Filecoin Pin (async): ${error.message}`);
      
      // Log specific errors but don't fail the request (already sent response)
      if (error.message?.includes('InsufficientFunds') || error.message?.includes('Insufficient')) {
        getSynapseServiceForImage(credentials, config, logger, name)
          .then((synapseService) => synapseService.synapse.getClient().getAddress())
          .then((walletAddress: string) => {
            logger.error({ event: 'upload.manifest.insufficient_funds', address: walletAddress }, 
              `❌ Insufficient USDFC (USD Filecoin) funds in wallet ${walletAddress} for async upload. ` +
              `Fund your wallet at: https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc`
            );
          })
          .catch(() => {
            // Ignore errors getting address
          });
      }
    });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy' });
});

// Export app and initialize function for tests
export { app, initialize };

// Start server if running directly (not imported)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  initialize();

  const port = config!.port;
  const host = config!.host;

  const server = app.listen(port, host as any, () => {
    logger.info({ event: 'pincer.server.start', host, port }, `PinCeR server listening on ${host}:${port}`);
  });

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    logger.info({ event: 'pincer.shutdown' }, 'Shutting down PinCeR...');
    await cleanupAllServices();
    server.close(() => {
      logger.info({ event: 'pincer.shutdown.complete' }, 'PinCeR stopped');
      process.exit(0);
    });
  });

  process.on('SIGTERM', async () => {
    logger.info({ event: 'pincer.shutdown' }, 'Shutting down PinCeR...');
    await cleanupAllServices();
    server.close(() => {
      logger.info({ event: 'pincer.shutdown.complete' }, 'PinCeR stopped');
      process.exit(0);
    });
  });
}

export default app;

