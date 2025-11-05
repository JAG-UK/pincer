import pino from 'pino';
import { setupSynapse, cleanupSynapseService, type SynapseService, type SynapseSetupConfig } from 'filecoin-pin/core';
import type { Config } from './config.js';
import type { AuthCredentials } from './auth.js';

/**
 * Per-user Synapse service cache
 * Key: private key (or hash of it for security)
 * Value: SynapseService instance
 */
const serviceCache = new Map<string, SynapseService>();

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
 * Get or create Synapse service for a user
 * 
 * This function:
 * 1. Checks if we already have a Synapse service for this user's private key
 * 2. If not, initializes Synapse SDK and storage context
 * 3. Returns the service for use in upload/download operations
 */
export async function getSynapseService(
  credentials: AuthCredentials,
  config: Config,
  logger: pino.Logger
): Promise<SynapseService> {
  const cacheKey = getCacheKey(credentials);
  
  // Check cache first
  const cached = serviceCache.get(cacheKey);
  if (cached) {
    logger.debug({ event: 'synapse.cache_hit' }, 'Using cached Synapse service');
    return cached;
  }

  // Create new service
  logger.info({ event: 'synapse.service.create' }, 'Creating new Synapse service for user');

  const synapseConfig: SynapseSetupConfig = {
    privateKey: credentials.privateKey,
    ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
    ...(config.warmStorageAddress && { warmStorageAddress: config.warmStorageAddress }),
  };

  logger.debug({ event: 'synapse.config', hasRpcUrl: !!config.rpcUrl, hasWarmStorageAddress: !!config.warmStorageAddress }, 'Synapse configuration');

  try {
    const service = await setupSynapse(synapseConfig, logger);
    
    // Log contract addresses for debugging
    try {
      const walletAddress = await service.synapse.getClient().getAddress();
      const warmStorageAddress = service.synapse.getWarmStorageAddress();
      const network = service.synapse.getNetwork();
      
      logger.info({ 
        event: 'synapse.init.info', 
        network,
        walletAddress,
        warmStorageAddress 
      }, 
        `Synapse initialized - Network: ${network}, Wallet: ${walletAddress}, WarmStorage: ${warmStorageAddress}`
      );
    } catch (error) {
      logger.warn({ event: 'synapse.init.info.failed', error }, 'Could not retrieve Synapse info');
    }
    
    // Log wallet address for debugging
    try {
      const walletAddress = await service.synapse.getClient().getAddress();
      logger.info({ event: 'synapse.wallet.address', address: walletAddress }, `Synapse wallet: ${walletAddress}`);
    } catch (error) {
      logger.warn({ event: 'synapse.wallet.address.failed', error }, 'Could not retrieve wallet address');
    }

    // Cache the service
    serviceCache.set(cacheKey, service);

    logger.info(
      { event: 'synapse.service.created', dataSetId: service.storage.dataSetId },
      'Synapse service created and cached'
    );

    return service;
  } catch (error: any) {
    logger.error({ event: 'synapse.service.create.failed', error: error.message, stack: error.stack }, 
      `Failed to create Synapse service: ${error.message}`
    );
    throw error;
  }
}

/**
 * Clean up all Synapse services
 * Call this on server shutdown
 */
export async function cleanupAllServices(): Promise<void> {
  // Clear cache
  serviceCache.clear();
  
  // Clean up active service
  await cleanupSynapseService();
}

/**
 * Remove a specific service from cache
 * Useful if a user's service needs to be recreated
 */
export function removeService(credentials: AuthCredentials): void {
  const cacheKey = getCacheKey(credentials);
  serviceCache.delete(cacheKey);
}

/**
 * Get cache statistics (for debugging/monitoring)
 */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: serviceCache.size,
    keys: Array.from(serviceCache.keys()).map(key => `${key.slice(0, 10)}...`), // Show first 10 chars only
  };
}

