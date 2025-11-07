#!/usr/bin/env tsx
/**
 * List all content uploaded to Filecoin Pin via Synapse
 * 
 * Usage:
 *   TEST_PRIVATE_KEY=0x1234... npm run tools:list
 */
import pino from 'pino';
import { setupSynapse, cleanupSynapseService } from 'filecoin-pin/core';
import { PDPServer, WarmStorageService, PDPVerifier } from '@filoz/synapse-sdk';

const logger = pino({
  level: 'info',
});

async function main() {
  const privateKey = process.env.TEST_PRIVATE_KEY;
  
  if (!privateKey) {
    console.error('❌ TEST_PRIVATE_KEY environment variable not set');
    console.error('   Usage: TEST_PRIVATE_KEY=0x1234... npm run tools:list');
    process.exit(1);
  }

  // Normalize private key (add 0x if missing)
  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  console.log('\n📦 Listing Filecoin Pin Uploads\n');
  console.log('='.repeat(60));

  let service;
  try {
    // Step 1: Initialize Synapse
    console.log('\n⨍ Step 1: Initializing Synapse...');
    service = await setupSynapse(
      {
        privateKey: normalizedKey,
        // Use default calibration network
      },
      logger
    );

    const walletAddress = await service.synapse.getClient().getAddress();
    const network = service.synapse.getNetwork();
    const dataSetId = service.storage.dataSetId;

    console.log(`✅ Synapse initialized`);
    console.log(`   Network: ${network}`);
    console.log(`   Wallet: ${walletAddress}`);
    console.log(`   Current Dataset ID: ${dataSetId}`);

    // Step 2: Get all datasets for this wallet
    console.log('\n📊 Step 2: Fetching all datasets...');
    const dataSets = await service.synapse.storage.findDataSets(walletAddress);
    console.log(`   Found ${dataSets.length} dataset(s)`);

    if (dataSets.length === 0) {
      console.log('\n   No datasets found. Upload some content first!');
      return;
    }

    // Step 3: For each dataset, get pieces
    console.log('\n📋 Step 3: Fetching pieces for each dataset...\n');
    
    const warmStorage = await WarmStorageService.create(
      service.synapse.getProvider(),
      service.synapse.getWarmStorageAddress()
    );

    for (const dataSet of dataSets) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Dataset ID: ${dataSet.pdpVerifierDataSetId}`);
      console.log(`Provider ID: ${dataSet.providerId}`);
      if (dataSet.metadata) {
        console.log(`Metadata: ${JSON.stringify(dataSet.metadata)}`);
      }

      // Get provider info to find PDP service URL
      const storageInfo = await service.synapse.storage.getStorageInfo();
      const provider = storageInfo?.providers?.find(p => p.id === dataSet.providerId);
      
      if (!provider?.products?.PDP?.data?.serviceURL) {
        console.log(`   ⚠️  No PDP service URL available for this provider`);
        continue;
      }

      const serviceURL = provider.products.PDP.data.serviceURL;
      console.log(`   PDP Service URL: ${serviceURL}`);

      try {
        // Get pieces from PDP server
        const pdpServer = new PDPServer(null, serviceURL);
        const dataSetData = await pdpServer.getDataSet(dataSet.pdpVerifierDataSetId);
        
        console.log(`   Pieces: ${dataSetData.pieces.length}`);
        
        if (dataSetData.pieces.length > 0) {
          console.log(`\n   Piece Details:`);
          for (const piece of dataSetData.pieces) {
            // Get metadata for this piece
            let metadata = {};
            try {
              metadata = await warmStorage.getPieceMetadata(
                dataSet.pdpVerifierDataSetId,
                piece.pieceId
              );
            } catch (error) {
              // Metadata might not be available
            }

            console.log(`\n   Piece #${piece.pieceId}:`);
            console.log(`     CID: ${piece.pieceCid.toString()}`);
            console.log(`     IPFS URL: https://ipfs.io/ipfs/${piece.pieceCid.toString()}`);
            if (Object.keys(metadata).length > 0) {
              console.log(`     Metadata: ${JSON.stringify(metadata, null, 6)}`);
            }
          }
        }
      } catch (error: any) {
        console.log(`   ❌ Failed to fetch pieces: ${error.message}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Listing complete!\n');

  } catch (error: any) {
    console.error('\n❌ Failed:');
    console.error(`   Error: ${error.message}`);
    if (error.stack) {
      console.error(`\nStack trace:`);
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    // Cleanup
    if (service) {
      await cleanupSynapseService();
    }
  }
}

// Run the script
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

