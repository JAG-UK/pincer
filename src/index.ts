import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import { loadConfig, Config } from './config.js';
import { ImageMapping } from './mapping.js';
import { BlobStorage } from './storage.js';
import { parseManifestLayers } from './utils.js';

const app = express();

// Configure Express to handle trailing slashes consistently
app.set('strict routing', false);

// Global state
let config: Config;
let imageMapping: ImageMapping;
let blobStorage: BlobStorage;

// Initialize on startup
function initialize() {
  config = loadConfig();
  imageMapping = new ImageMapping(config.mappingFile);
  blobStorage = new BlobStorage(config.storageDir);
  
  console.log('PinCeR started');
  console.log(`Blob storage directory: ${config.storageDir}`);
}

// Middleware
app.use(express.raw({ type: '*/*', limit: '10gb' }));

// OCI Distribution Spec endpoints

app.get('/v2/', (req: Request, res: Response) => {
  res.json({ version: '2.0' });
});

app.head('/v2/', (req: Request, res: Response) => {
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
  
  // TODO: Fetch manifest from Filecoin Pin using CID if cid doesn't start with 'sha256:'
  // For now, check local storage first
  // The mapping stores the digest directly for local storage
  // If the CID is a digest (starts with 'sha256:'), use it directly
  // Otherwise, it's a Filecoin Pin CID and we should fetch from there
  const manifestDigest = cid.startsWith('sha256:') ? cid : null;
  
  if (!manifestDigest) {
    // TODO: Fetch from Filecoin Pin using CID
    return res.status(404).json({ error: `Manifest not found - Filecoin Pin integration needed (CID: ${cid})` });
  }
  
  const manifestPath = blobStorage.getManifestPath(manifestDigest);
  
  if (!manifestPath) {
    // TODO: Fetch from Filecoin Pin if not found locally
    return res.status(404).json({ error: `Manifest not found locally (digest: ${manifestDigest})` });
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
  
  // Use the digest from the mapping (which matches what we stored)
  // This ensures consistency with what Docker expects
  const digest = manifestDigest;
  
  // Return manifest with proper headers
  res.set({
    'Content-Type': contentType,
    'Docker-Content-Digest': digest,
    'Content-Length': manifestBytes.length.toString(),
  });
  res.send(manifestBytes);
});

app.head('/v2/*/manifests/:reference', (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'manifests') || '';
  const reference = req.path.split('/manifests/').pop()?.split('?')[0] || '';
  
  const cid = imageMapping.getManifestCid(name, reference);
  
  if (!cid) {
    return res.sendStatus(404);
  }
  
  // Check if manifest exists locally
  // The mapping stores the digest directly for local storage
  const manifestDigest = cid.startsWith('sha256:') ? cid : null;
  
  if (!manifestDigest) {
    // TODO: Check Filecoin Pin if CID is not a digest
    return res.sendStatus(404);
  }
  
  const manifestPath = blobStorage.getManifestPath(manifestDigest);
  if (!manifestPath) {
    // TODO: Check Filecoin Pin if not found locally
    return res.sendStatus(404);
  }
  
  // Return digest in header so Docker can resolve tag to digest
  // This is critical for Docker to know which digest to pull
  res.set({
    'Docker-Content-Digest': manifestDigest,
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
  
  // TODO: Fetch blob from Filecoin Pin using CID
  // For now, check local storage first
  const blobPath = blobStorage.getBlobPath(digest);
  
  if (!blobPath) {
    // TODO: Fetch from Filecoin Pin if not found locally
    return res.status(404).json({ error: `Blob not found locally (digest: ${digest}, CID: ${cid})` });
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
      console.error(`Failed to read blob from filesystem: ${error}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read blob from filesystem' });
      } else {
        res.destroy();
      }
    });
  } catch (error: any) {
    console.error(`Failed to fetch blob: ${error}`);
    if (!res.headersSent) {
      res.status(404).json({ error: 'Failed to fetch blob' });
    } else {
      res.destroy();
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
  
  // Check if blob exists locally
  if (!blobStorage.blobExists(digest)) {
    // TODO: Check Filecoin Pin if not found locally
    return res.sendStatus(404);
  }
  
  res.sendStatus(200);
});

// Push endpoints

// Handle blob upload start - image name can contain slashes (e.g., "test/pincer-self-test")
// Use wildcard pattern to match everything after /v2/ and before /blobs/uploads
app.post('/v2/*/blobs/uploads', (req: Request, res: Response) => {
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
app.post('/v2/*/blobs/uploads/', (req: Request, res: Response) => {
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

app.patch('/v2/*/blobs/uploads/:uploadId', (req: Request, res: Response) => {
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

app.put('/v2/*/blobs/uploads/:uploadId', (req: Request, res: Response) => {
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
  
  // Complete upload and save blob
  const actualDigest = blobStorage.completeUpload(uploadId, digest);
  
  // Store blob mapping (digest -> placeholder CID for now)
  // TODO: Replace with actual Filecoin Pin CID
  const placeholderCid = `stub_cid_${actualDigest.replace('sha256:', '').slice(0, 16)}`;
  
  // Add blob mapping
  const blobMapping = imageMapping.getBlobCid(name, actualDigest);
  if (!blobMapping) {
    // Get or create blob mappings for this image
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
        data.blobs[actualDigest] = placeholderCid;
      }
    });
  }
  
  const location = `/v2/${name}/blobs/${actualDigest}`;
  
  res.status(201);
  res.set({
    'Location': location,
    'Docker-Content-Digest': actualDigest,
    'Content-Length': '0',
  });
  res.send();
});

app.put('/v2/*/manifests/:reference', (req: Request, res: Response) => {
  // Extract name from path to handle slashes (e.g., "test/pincer-self-test")
  const name = extractImageName(req.path, 'manifests') || '';
  const reference = req.path.split('/manifests/').pop()?.split('?')[0] || '';
  
  const manifestBytes = req.body as Buffer;
  
  if (!manifestBytes || manifestBytes.length === 0) {
    return res.status(400).json({ error: 'No manifest data provided' });
  }
  
  // Parse manifest JSON for validation and layer extraction
  let manifestData: any;
  try {
    manifestData = JSON.parse(manifestBytes.toString('utf-8'));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON manifest' });
  }

  // Save manifest to local storage - use the raw bytes to preserve exact digest
  const manifestDigest = blobStorage.saveManifest(name, reference, manifestBytes);
  
  // For local storage, store the digest directly (not a CID)
  // TODO: When uploading to Filecoin Pin, replace with actual CID
  // For now, we use the digest as the lookup key since files are stored by digest locally
  
  // Extract layer digests and create blob mappings
  const layers = parseManifestLayers(manifestData);
  const blobMappings: Record<string, string> = {};
  
  for (const layer of layers) {
    const layerDigest = layer.digest;
    if (layerDigest) {
      // Check if blob exists locally
      if (blobStorage.blobExists(layerDigest)) {
        // For local storage, we can use the digest itself or a placeholder
        // The blob mapping isn't strictly needed for local storage since we look up by digest
        // But we'll store a placeholder for future Filecoin Pin integration
        const blobCid = `stub_cid_${layerDigest.replace('sha256:', '').slice(0, 16)}`;
        blobMappings[layerDigest] = blobCid;
      }
    }
  }
  
  // Store manifest mapping - use digest for local storage lookup
  // TODO: When Filecoin Pin is integrated, store actual CID here
  imageMapping.addMapping(
    name,
    reference,
    manifestDigest, // Store digest directly for local storage lookup
    Object.keys(blobMappings).length > 0 ? blobMappings : undefined
  );
  
  // Also store mapping for the digest itself, so Docker can pull by digest
  // Docker resolves tag -> digest via HEAD, then pulls by digest
  if (reference !== manifestDigest) {
    imageMapping.addMapping(
      name,
      manifestDigest, // Store digest as its own reference
      manifestDigest,
      Object.keys(blobMappings).length > 0 ? blobMappings : undefined
    );
    console.log(`Also stored manifest ${manifestDigest} for ${name}:${manifestDigest}`);
  }
  
  console.log(`Stored manifest ${manifestDigest} for ${name}:${reference}`);
  
  res.status(201);
  res.set({
    'Docker-Content-Digest': manifestDigest,
    'Location': `/v2/${name}/manifests/${reference}`,
    'Content-Length': manifestBytes.length.toString(),
  });
  res.send();
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

  app.listen(port, host as any, () => {
    console.log(`PinCeR server listening on ${host}:${port}`);
  });
}

export default app;

