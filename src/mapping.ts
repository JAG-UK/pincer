import { readFileSync, writeFileSync, existsSync } from 'fs';

// Mapping data structure - flexible JSON structure
type MappingData = Record<string, any>;

export class ImageMapping {
  private mappings: MappingData = {};
  private mappingFile: string;

  constructor(mappingFile: string) {
    this.mappingFile = mappingFile;
    this.loadMappings();
  }

  private loadMappings(): void {
    if (existsSync(this.mappingFile)) {
      try {
        const content = readFileSync(this.mappingFile, 'utf-8');
        this.mappings = JSON.parse(content);
        console.log(`Loaded ${Object.keys(this.mappings).length} image mappings`);
      } catch (error) {
        console.error(`Failed to load mappings: ${error}`);
        this.mappings = {};
      }
    } else {
      console.warn(`Mapping file not found: ${this.mappingFile}`);
      this.mappings = {};
    }
  }

  private saveMappings(): void {
    try {
      writeFileSync(this.mappingFile, JSON.stringify(this.mappings, null, 2));
    } catch (error) {
      console.error(`Failed to save mappings: ${error}`);
    }
  }

  getManifestCid(imageName: string, reference: string): string | null {
    const imageKey = `${imageName}:${reference}`;

    // Check direct mapping
    const mapping = this.mappings[imageKey];
    if (mapping) {
      if (typeof mapping === 'string') {
        return mapping;
      }
      if (typeof mapping === 'object' && mapping !== null && 'manifest_cid' in mapping) {
        return mapping.manifest_cid as string;
      }
    }

    // Check nested structure
    const imageData = this.mappings[imageName];
    if (imageData && typeof imageData === 'object' && imageData !== null && reference in imageData) {
      const tagData = imageData[reference];
      if (typeof tagData === 'string') {
        return tagData;
      }
      if (typeof tagData === 'object' && tagData !== null && 'manifest_cid' in tagData) {
        return tagData.manifest_cid as string;
      }
    }

    // If reference is a digest (sha256:...), try to find it by iterating through mappings
    // This handles the case where Docker resolves tag -> digest and then pulls by digest
    if (reference.startsWith('sha256:')) {
      // Iterate through all mappings for this image name
      for (const [key, value] of Object.entries(this.mappings)) {
        if (key.startsWith(`${imageName}:`)) {
          let manifestCid: string | null = null;
          if (typeof value === 'string') {
            manifestCid = value;
          } else if (typeof value === 'object' && value !== null && 'manifest_cid' in value) {
            manifestCid = value.manifest_cid as string;
          }
          
          // If the stored digest matches the reference digest, return it
          if (manifestCid === reference) {
            return manifestCid;
          }
        }
      }
    }

    return null;
  }

  getBlobCid(imageName: string, digest: string): string | null {
    // Check image-specific blob mappings
    const imageData = this.mappings[imageName];
    if (imageData && typeof imageData === 'object' && imageData !== null && 'blobs' in imageData) {
      const blobs = imageData.blobs;
      if (blobs && typeof blobs === 'object' && blobs !== null && digest in blobs) {
        return blobs[digest] as string;
      }
    }

    // Check global blob mappings (under "blobs" key)
    const globalBlobs = this.mappings.blobs;
    if (globalBlobs && typeof globalBlobs === 'object' && globalBlobs !== null && digest in globalBlobs) {
      const value = globalBlobs[digest];
      if (typeof value === 'string') {
        return value;
      }
    }

    return null;
  }

  addMapping(
    imageName: string,
    reference: string,
    manifestCid: string,
    blobs?: Record<string, string>
  ): void {
    const imageKey = `${imageName}:${reference}`;

    if (blobs && Object.keys(blobs).length > 0) {
      this.mappings[imageKey] = {
        manifest_cid: manifestCid,
        blobs,
      };
    } else {
      this.mappings[imageKey] = manifestCid;
    }

    this.saveMappings();
    console.log(`Added mapping: ${imageKey} -> ${manifestCid}`);
  }

  // Update mappings (for external updates)
  updateMappings(updater: (mappings: MappingData) => void): void {
    updater(this.mappings);
    this.saveMappings();
  }
}
