import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { computeDigest } from './utils.js';

export class UploadSession {
  uploadId: string;
  name: string;
  chunks: Buffer[] = [];
  size: number = 0;

  constructor(uploadId: string, name: string) {
    this.uploadId = uploadId;
    this.name = name;
  }

  appendChunk(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  getData(): Buffer {
    return Buffer.concat(this.chunks);
  }

  getDigest(): string {
    const data = this.getData();
    return computeDigest(data);
  }
}

export class BlobStorage {
  private storageDir: string;
  private blobsDir: string;
  private manifestsDir: string;
  uploadSessions: Map<string, UploadSession> = new Map();

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.blobsDir = join(storageDir, 'blobs');
    this.manifestsDir = join(storageDir, 'manifests');

    // Create directories
    mkdirSync(this.blobsDir, { recursive: true });
    mkdirSync(this.manifestsDir, { recursive: true });

    console.log(`Initialized blob storage at ${this.storageDir}`);
  }

  startUpload(name: string): string {
    const uploadId = randomUUID();
    const session = new UploadSession(uploadId, name);
    this.uploadSessions.set(uploadId, session);
    console.debug(`Started upload session ${uploadId} for ${name}`);
    return uploadId;
  }

  appendChunk(uploadId: string, chunk: Buffer): void {
    const session = this.uploadSessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }
    session.appendChunk(chunk);
    console.debug(`Appended ${chunk.length} bytes to upload ${uploadId}`);
  }

  completeUpload(uploadId: string, digest?: string): string {
    const session = this.uploadSessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const blobData = session.getData();
    const actualDigest = session.getDigest();

    // Verify digest if provided
    if (digest && digest !== actualDigest) {
      throw new Error(`Digest mismatch: expected ${digest}, got ${actualDigest}`);
    }

    // Save blob to filesystem
    const blobDigest = actualDigest.replace('sha256:', '');
    const blobPath = join(this.blobsDir, blobDigest);

    writeFileSync(blobPath, blobData);
    console.log(`Saved blob ${actualDigest} (${blobData.length} bytes) to ${blobPath}`);

    // TODO: Upload to Filecoin Pin here
    // For now, return a placeholder CIDv2
    const cid = `stub_cid_${blobDigest.slice(0, 16)}`;
    console.log(`Calculated placeholder CID ${cid} for blob ${actualDigest}`);

    // Clean up session
    this.uploadSessions.delete(uploadId);

    return actualDigest;
  }

  saveManifest(name: string, reference: string, manifestBytes: Buffer): string {
    // Compute digest from the exact bytes received (don't re-stringify)
    const digest = computeDigest(manifestBytes);

    // Save manifest to filesystem
    const manifestDigest = digest.replace('sha256:', '');
    const manifestPath = join(this.manifestsDir, manifestDigest);

    writeFileSync(manifestPath, manifestBytes);
    console.log(`Saved manifest ${digest} for ${name}:${reference}`);

    // TODO: Upload to Filecoin Pin here
    const cid = `stub_cid_${manifestDigest.slice(0, 16)}`;

    return digest;
  }

  getBlobPath(digest: string): string | null {
    const blobDigest = digest.replace('sha256:', '');
    const blobPath = join(this.blobsDir, blobDigest);

    if (existsSync(blobPath)) {
      return blobPath;
    }

    return null;
  }

  blobExists(digest: string): boolean {
    return this.getBlobPath(digest) !== null;
  }

  getManifestPath(digest: string): string | null {
    const manifestDigest = digest.replace('sha256:', '');
    const manifestPath = join(this.manifestsDir, manifestDigest);

    if (existsSync(manifestPath)) {
      return manifestPath;
    }

    return null;
  }

  manifestExists(digest: string): boolean {
    return this.getManifestPath(digest) !== null;
  }
}

