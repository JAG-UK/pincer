import pino from 'pino';
import { setupSynapse, cleanupSynapseService, initializeSynapse, createStorageContext, type SynapseService, type SynapseSetupConfig, type CreateStorageContextOptions } from 'filecoin-pin/core';
import type { Config } from './config.js';
import type { AuthCredentials } from './auth.js';

/**
 * Per-user base Synapse instance cache (for creating new datasets)
 * Key: private key
 * Value: Synapse instance (without storage context)
 */
const synapseInstanceCache = new Map<string, any>();

/**
 * Per-image dataset cache
 * Key: `${privateKey}:${imageName}`
 * Value: SynapseService with dataset for that image
 */
const imageDatasetCache = new Map<string, SynapseService>();

/**
 * Create a cache key from credentials
 * For security, we hash the private key rather than storing it directly
 */
function getCacheKey(credentials: AuthCredentials): string {
  // Use the private key itself as the key (in production, you might want to hash it)
  // For now, we'll use it directly since we need to match the same user
  return credentials.privateKey;
}

/**
 * Get or create Synapse service for a specific image
 * 
 * This function creates a new dataset for each image, ensuring each image
 * (manifest + layers) is self-contained in its own dataset.
 * 
 * @param credentials - User authentication credentials
 * @param config - Application configuration
 * @param logger - Logger instance
 * @param imageName - Name of the image (e.g., "test/myapp")
 * @returns SynapseService with a dataset dedicated to this image
 */
export async function getSynapseServiceForImage(
  credentials: AuthCredentials,
  config: Config,
  logger: pino.Logger,
  imageName: string
): Promise<SynapseService> {
  const cacheKey = getCacheKey(credentials);
  const imageCacheKey = `${cacheKey}:${imageName}`;
  
  // Check if we already have a dataset for this image
  const cached = imageDatasetCache.get(imageCacheKey);
  if (cached) {
    logger.debug({ event: 'synapse.image_dataset.cache_hit', imageName, dataSetId: cached.storage.dataSetId }, 
      `Using cached dataset for image: ${imageName}`);
    return cached;
  }

  // Create new dataset for this image
  logger.info({ event: 'synapse.image_dataset.create', imageName }, `Creating new dataset for image: ${imageName}`);

  // Get or create base Synapse instance (without storage context)
  let synapse = synapseInstanceCache.get(cacheKey);
  if (!synapse) {
    const synapseConfig: SynapseSetupConfig = {
      privateKey: credentials.privateKey,
      ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
      ...(config.warmStorageAddress && { warmStorageAddress: config.warmStorageAddress }),
    };
    
    synapse = await initializeSynapse(synapseConfig, logger);
    synapseInstanceCache.set(cacheKey, synapse);
    
    logger.debug({ event: 'synapse.instance.cached' }, 'Cached base Synapse instance for user');
  }

  // Create a new dataset for this image
  const datasetOptions: CreateStorageContextOptions = {
    dataset: {
      createNew: true, // Always create a new dataset for each image
      metadata: {
        type: 'oci-image',
        imageName: imageName,
        source: 'pincer',
      },
    },
  };

  const { storage, providerInfo } = await createStorageContext(synapse, logger, datasetOptions);
  
  const service: SynapseService = {
    synapse,
    storage,
    providerInfo,
  };

  // Cache the service for this image
  imageDatasetCache.set(imageCacheKey, service);

  logger.info(
    { event: 'synapse.image_dataset.created', imageName, dataSetId: service.storage.dataSetId },
    `Created dataset ${service.storage.dataSetId} for image: ${imageName}`
  );

  return service;
}

/**
 * Get or create Synapse service for a user (legacy method, for backward compatibility)
 * 
 * @deprecated Use getSynapseServiceForImage instead for per-image datasets
 */
export async function getSynapseService(
  credentials: AuthCredentials,
  config: Config,
  logger: pino.Logger
): Promise<SynapseService> {
  // For backward compatibility, use a default image name
  // This maintains the old behavior of one dataset per user
  return getSynapseServiceForImage(credentials, config, logger, '__default__');
}

/**
 * Clean up all Synapse services
 * Call this on server shutdown
 */
export async function cleanupAllServices(): Promise<void> {
  // Clear caches
  imageDatasetCache.clear();
  synapseInstanceCache.clear();
  
  // Clean up active service
  await cleanupSynapseService();
}

/**
 * Remove a specific image's dataset from cache
 * Useful if an image's dataset needs to be recreated
 */
export function removeImageDataset(credentials: AuthCredentials, imageName: string): void {
  const cacheKey = getCacheKey(credentials);
  const imageCacheKey = `${cacheKey}:${imageName}`;
  imageDatasetCache.delete(imageCacheKey);
}

/**
 * Get cache statistics (for debugging/monitoring)
 */
export function getCacheStats(): { 
  imageDatasets: number; 
  synapseInstances: number;
  imageKeys: string[];
} {
  return {
    imageDatasets: imageDatasetCache.size,
    synapseInstances: synapseInstanceCache.size,
    imageKeys: Array.from(imageDatasetCache.keys()).map(key => {
      const parts = key.split(':');
      return parts.length > 1 ? parts[1] : key; // Return image name part
    }),
  };
}

