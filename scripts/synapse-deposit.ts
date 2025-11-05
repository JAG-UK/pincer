#!/usr/bin/env tsx
/**
 * Utility script for Synapse deposit/approval flow
 * 
 * This script can:
 * 1. Initialize Synapse
 * 2. Check balances (FIL, USDFC, Warm Storage)
 * 3. Approve token (5 USDFC) - optional
 * 4. Approve service provider as operator - optional
 * 5. Deposit to Warm Storage - optional
 * 
 * Usage:
 *   # Approve token only
 *   TEST_PRIVATE_KEY=0x1234... APPROVE_TOKEN=true npm run tools:deposit
 * 
 *   # Approve service provider only
 *   TEST_PRIVATE_KEY=0x1234... APPROVE_SERVICE=true npm run tools:deposit
 * 
 *   # Deposit only (specify amount)
 *   TEST_PRIVATE_KEY=0x1234... DEPOSIT_AMOUNT=0.1 npm run tools:deposit
 * 
 *   # Do multiple operations
 *   TEST_PRIVATE_KEY=0x1234... APPROVE_TOKEN=true APPROVE_SERVICE=true DEPOSIT_AMOUNT=0.1 npm run tools:deposit
 */
import pino from 'pino';
import { setupSynapse, cleanupSynapseService } from 'filecoin-pin/core';
import { checkFILBalance, checkUSDFCBalance, getPaymentStatus, depositUSDFC, setServiceApprovals } from 'filecoin-pin/core/payments';
import { TOKENS } from '@filoz/synapse-sdk';
import { MaxUint256 } from 'ethers';

// Define max allowances (matching SDK constants)
const MAX_RATE_ALLOWANCE = MaxUint256;
const MAX_LOCKUP_ALLOWANCE = MaxUint256;

const logger = pino({
  level: 'info',
});

async function main() {
  const privateKey = process.env.TEST_PRIVATE_KEY;
  
  if (!privateKey) {
    console.error('❌ TEST_PRIVATE_KEY environment variable not set');
    console.error('   Usage: TEST_PRIVATE_KEY=0x1234... npm run tools:deposit');
    process.exit(1);
  }

  // Normalize private key (add 0x if missing)
  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  // Check which operations to perform
  const shouldApproveToken = process.env.APPROVE_TOKEN === 'true';
  const shouldApproveService = process.env.APPROVE_SERVICE === 'true';
  const depositAmountEnv = process.env.DEPOSIT_AMOUNT; // Amount in USDFC (e.g., "0.1" or "5")
  const shouldDeposit = depositAmountEnv !== undefined;

  console.log('\n💰 Synapse Deposit\n');
  console.log('='.repeat(60));
  console.log(`Operations:`);
  console.log(`  - Check balances: yes`);
  console.log(`  - Approve token: ${shouldApproveToken ? 'yes' : 'no'}`);
  console.log(`  - Approve service provider: ${shouldApproveService ? 'yes' : 'no'}`);
  console.log(`  - Deposit: ${shouldDeposit ? `${depositAmountEnv} USDFC` : 'no'}`);
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
    const warmStorageAddress = service.synapse.getWarmStorageAddress();

    console.log(`✅ Synapse initialized`);
    console.log(`   Network: ${network}`);
    console.log(`   Wallet: ${walletAddress}`);
    console.log(`   WarmStorage: ${warmStorageAddress}`);

    // Step 2: Check balances
    console.log('\n📊 Step 2: Checking balances...');
    
    try {
      // Check FIL balance
      const filStatus = await checkFILBalance(service.synapse);
      const filBalanceFormatted = (Number(filStatus.balance) / 1e18).toFixed(6);
      console.log(`   FIL: ${filBalanceFormatted} FIL`);
      
      // Check USDFC wallet balance
      const usdfcWalletBalance = await checkUSDFCBalance(service.synapse);
      const usdfcWalletFormatted = (Number(usdfcWalletBalance) / 1e18).toFixed(6);
      console.log(`   USDFC (Wallet): ${usdfcWalletFormatted} USDFC`);

      // Check payment status (includes Warm Storage balance)
      const paymentStatus = await getPaymentStatus(service.synapse);
      const usdfcDepositedFormatted = (Number(paymentStatus.filecoinPayBalance) / 1e18).toFixed(6);
      console.log(`   USDFC (Warm Storage): ${usdfcDepositedFormatted} USDFC`);
      
      console.log(`\n✅ Balance check complete`);
    } catch (balanceError: any) {
      console.error(`❌ Balance check failed: ${balanceError.message}`);
      if (balanceError.message?.includes('actor not found') || balanceError.message?.includes('ActorNotFound')) {
        console.error('\n⚠️  Wallet not initialized on Filecoin!');
        console.error(`   Send 0.001 FIL to ${walletAddress} to initialize it.`);
        console.error(`   Faucet: https://beryx.io/faucet`);
        process.exit(1);
      }
      throw balanceError;
    }

    // Step 3: Approve token (optional)
    if (shouldApproveToken) {
      console.log('\n🔐 Step 3: Approving token...');
      
      const approveAmount = BigInt('5000000000000000000'); // 5 USDFC
      
      try {
        const approveTx = await service.synapse.payments.approve(
          warmStorageAddress,
          approveAmount,
          TOKENS.USDFC
        );
        
        console.log(`   Transaction hash: ${approveTx.hash}`);
        console.log(`   Waiting for confirmation...`);
        
        // Wait for transaction to be mined
        const receipt = await approveTx.wait();
        
        console.log(`✅ Approval successful!`);
        console.log(`   Approved: 5 USDFC`);
        console.log(`   Transaction: ${approveTx.hash}`);
        console.log(`   Block: ${receipt.blockNumber}`);
        
        // Wait for settlement to avoid nonce conflicts
        console.log(`   Waiting 30 seconds for settlement...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (approveError: any) {
        if (approveError.message?.includes('nonce already used') || approveError.message?.includes('nonce has already been used')) {
          console.warn(`⚠️  Nonce conflict - transaction may already be pending`);
          console.warn(`   This is OK if you just ran this script. Wait a moment and try again.`);
          console.warn(`   Error: ${approveError.message}`);
        } else {
          console.error(`❌ Approval failed: ${approveError.message}`);
          throw approveError;
        }
      }
    } else {
      console.log('\n🔐 Step 3: Skipping token approval (APPROVE_TOKEN not set to true)');
    }

    // Step 4: Approve service provider as operator (optional)
    if (shouldApproveService) {
      console.log('\n🔐 Step 4: Approving service provider as operator...');
      
      try {
        const approveServiceTx = await setServiceApprovals(
          service.synapse,
          MAX_RATE_ALLOWANCE,
          MAX_LOCKUP_ALLOWANCE
        );
        
        console.log(`   Transaction hash: ${approveServiceTx}`);
        console.log(`   Approved service provider with max allowances`);
        console.log(`   Transaction: ${approveServiceTx}`);
        
        // Wait for transaction to be mined (setServiceApprovals returns the hash, not a transaction object)
        console.log(`   Waiting for confirmation...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds for transaction
        
        // Wait additional time for settlement
        console.log(`   Waiting 30 seconds for settlement...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (approveServiceError: any) {
        if (approveServiceError.message?.includes('nonce already used') || approveServiceError.message?.includes('nonce has already been used')) {
          console.warn(`⚠️  Nonce conflict - transaction may already be pending`);
          console.warn(`   This is OK if you just ran this script. Wait a moment and try again.`);
          console.warn(`   Error: ${approveServiceError.message}`);
          throw approveServiceError;
        } else {
          console.error(`❌ Service provider approval failed: ${approveServiceError.message}`);
          throw approveServiceError;
        }
      }
    } else {
      console.log('\n🔐 Step 4: Skipping service provider approval (APPROVE_SERVICE not set to true)');
    }

    // Step 5: Deposit to Warm Storage (optional)
    if (shouldDeposit) {
      console.log('\n💸 Step 5: Depositing to Warm Storage...');
      
      // Parse deposit amount from environment variable
      const depositAmountFormatted = depositAmountEnv!;
      const depositAmount = BigInt(Math.floor(parseFloat(depositAmountFormatted) * 1e18).toString());
      
      console.log(`   Amount: ${depositAmountFormatted} USDFC`);
      
      try {
        const depositResult = await depositUSDFC(service.synapse, depositAmount);
        
        console.log(`✅ Deposit successful!`);
        console.log(`   Deposited: ${depositAmountFormatted} USDFC`);
        console.log(`   Transaction: ${depositResult.depositTx}`);
        if (depositResult.approvalTx) {
          console.log(`   Approval TX: ${depositResult.approvalTx}`);
        }
        
        // Check updated balance
        console.log('\n💰 Checking updated Warm Storage balance...');
        const updatedPaymentStatus = await getPaymentStatus(service.synapse);
        const updatedDepositedFormatted = (Number(updatedPaymentStatus.filecoinPayBalance) / 1e18).toFixed(6);
        console.log(`   USDFC (Warm Storage): ${updatedDepositedFormatted} USDFC`);
        
      } catch (depositError: any) {
        if (depositError.message?.includes('nonce already used') || depositError.message?.includes('nonce has already been used')) {
          console.warn(`⚠️  Nonce conflict - transaction may already be pending`);
          console.warn(`   This is OK if you just ran this script. Wait a moment and try again.`);
          console.warn(`   Error: ${depositError.message}`);
          throw depositError;
        } else if (depositError.message?.includes('allowance check') || depositError.message?.includes('insufficient allowance')) {
          console.error(`❌ Deposit failed: Insufficient allowance`);
          console.error(`   Run with APPROVE_TOKEN=true to approve token first.`);
          console.error(`   Error: ${depositError.message}`);
          throw depositError;
        } else {
          console.error(`❌ Deposit failed: ${depositError.message}`);
          throw depositError;
        }
      }
    } else {
      console.log('\n💸 Step 5: Skipping deposit (DEPOSIT_AMOUNT not set)');
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Completed successfully!\n');

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
