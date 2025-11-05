import { describe, it, expect } from 'vitest';
import { ImageMapping } from './mapping.js';
import { BlobStorage } from './storage.js';
import { computeDigest, parseManifestLayers } from './utils.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

describe('ImageMapping', () => {
  const testMappingFile = '/tmp/test_mapping.json';

  beforeEach(() => {
    if (existsSync(testMappingFile)) {
      rmSync(testMappingFile);
    }
  });

  afterEach(() => {
    if (existsSync(testMappingFile)) {
      rmSync(testMappingFile);
    }
  });

  it('should create empty mapping for new file', () => {
    const mapping = new ImageMapping(testMappingFile);
    expect(mapping.getManifestCid('myapp', 'latest')).toBeNull();
  });

  it('should load existing mappings', () => {
    const data = {
      'myapp:latest': {
        manifest_cid: 'testcid123',
        blobs: {
          'sha256:abc123': 'blobcid123',
        },
      },
    };
    writeFileSync(testMappingFile, JSON.stringify(data));

    const mapping = new ImageMapping(testMappingFile);
    expect(mapping.getManifestCid('myapp', 'latest')).toBe('testcid123');
    expect(mapping.getBlobCid('myapp', 'sha256:abc123')).toBe('blobcid123');
  });

  it('should add and retrieve mappings', () => {
    const mapping = new ImageMapping(testMappingFile);
    mapping.addMapping('myapp', 'latest', 'testcid123');

    expect(mapping.getManifestCid('myapp', 'latest')).toBe('testcid123');
    expect(existsSync(testMappingFile)).toBe(true);
  });

  it('should handle nested blob mappings', () => {
    const mapping = new ImageMapping(testMappingFile);
    mapping.addMapping('myapp', 'latest', 'manifestcid', {
      'sha256:layer1': 'blobcid1',
    });

    expect(mapping.getManifestCid('myapp', 'latest')).toBe('manifestcid');
    expect(mapping.getBlobCid('myapp', 'sha256:layer1')).toBe('blobcid1');
  });
});

describe('BlobStorage', () => {
  const testStorageDir = '/tmp/test_storage';

  beforeEach(() => {
    if (existsSync(testStorageDir)) {
      rmSync(testStorageDir, { recursive: true });
    }
    mkdirSync(testStorageDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testStorageDir)) {
      rmSync(testStorageDir, { recursive: true });
    }
  });

  it('should create storage directories', () => {
    const storage = new BlobStorage(testStorageDir);
    expect(existsSync(join(testStorageDir, 'blobs'))).toBe(true);
    expect(existsSync(join(testStorageDir, 'manifests'))).toBe(true);
  });

  it('should handle upload sessions', () => {
    const storage = new BlobStorage(testStorageDir);
    const uploadId = storage.startUpload('myapp');

    expect(storage.uploadSessions.has(uploadId)).toBe(true);

    storage.appendChunk(uploadId, Buffer.from('test data'));
    const session = storage.uploadSessions.get(uploadId)!;
    expect(session.size).toBe(9);
  });

  it('should complete upload and save blob', () => {
    const storage = new BlobStorage(testStorageDir);
    const uploadId = storage.startUpload('myapp');
    storage.appendChunk(uploadId, Buffer.from('test blob data'));

    const digest = computeDigest(Buffer.from('test blob data'));
    const actualDigest = storage.completeUpload(uploadId, digest);

    expect(actualDigest).toBe(digest);
    expect(storage.uploadSessions.has(uploadId)).toBe(false);
    expect(storage.blobExists(digest)).toBe(true);
  });

  it('should save manifests', () => {
    const storage = new BlobStorage(testStorageDir);
    const manifestData = {
      schemaVersion: 2,
      layers: [{ digest: 'sha256:abc123', size: 1000 }],
    };

    const digest = storage.saveManifest('myapp', 'latest', manifestData);
    expect(digest).toMatch(/^sha256:/);
  });
});

describe('Utils', () => {
  it('should compute digests correctly', () => {
    const data = Buffer.from('test data');
    const digest = computeDigest(data);

    expect(digest).toMatch(/^sha256:/);
    expect(digest.length).toBe(71); // "sha256:" + 64 hex chars

    // Should be consistent
    const digest2 = computeDigest(data);
    expect(digest).toBe(digest2);
  });

  it('should parse Docker manifest layers', () => {
    const manifest = {
      schemaVersion: 2,
      layers: [
        { digest: 'sha256:abc123', size: 1000 },
        { digest: 'sha256:def456', size: 2000 },
      ],
    };

    const layers = parseManifestLayers(manifest);
    expect(layers.length).toBe(2);
    expect(layers[0].digest).toBe('sha256:abc123');
  });

  it('should parse OCI manifest layers', () => {
    const manifest = {
      layers: [{ digest: 'sha256:abc123', size: 1000 }],
    };

    const layers = parseManifestLayers(manifest);
    expect(layers.length).toBe(1);
    expect(layers[0].digest).toBe('sha256:abc123');
  });
});

