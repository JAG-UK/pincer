import { createHash } from 'crypto';

/**
 * Compute digest for OCI content.
 */
export function computeDigest(data: Buffer, algorithm: string = 'sha256'): string {
  if (algorithm === 'sha256') {
    const hash = createHash('sha256');
    hash.update(data);
    return `sha256:${hash.digest('hex')}`;
  }
  throw new Error(`Unsupported algorithm: ${algorithm}`);
}

export interface ManifestLayer {
  digest: string;
  size: number;
  [key: string]: any;
}

export interface Manifest {
  schemaVersion?: number;
  mediaType?: string;
  layers?: ManifestLayer[];
  fsLayers?: ManifestLayer[];
  [key: string]: any;
}

/**
 * Extract layer information from OCI/Docker manifest.
 */
export function parseManifestLayers(manifest: Manifest): ManifestLayer[] {
  // Docker manifest v2 format
  if (manifest.schemaVersion === 2) {
    return manifest.layers || [];
  }
  // OCI manifest format
  if (manifest.layers) {
    return manifest.layers;
  }
  // Fallback: check for fsLayers (legacy format)
  if (manifest.fsLayers) {
    return manifest.fsLayers;
  }
  return [];
}

/**
 * Extract layer digests from manifest.
 */
export function getLayerDigests(manifest: Manifest): string[] {
  const layers = parseManifestLayers(manifest);
  return layers
    .map(layer => layer.digest)
    .filter((digest): digest is string => Boolean(digest));
}

