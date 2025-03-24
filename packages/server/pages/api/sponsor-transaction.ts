import { NextApiRequest, NextApiResponse } from 'next';
import { 
  VersionedTransaction, 
  MessageV0,
  TransactionMessage,
  PublicKey
} from '@solana/web3.js';
import base58 from 'bs58';
import { cache, connection, cors, rateLimit, ENV_SECRET_KEYPAIR } from '../../src';

/**
 * API handler for sponsoring transactions by covering the transaction fees
 * The sponsor becomes the fee payer while preserving the user as a required signer
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply CORS and rate limiting middleware
  await cors(req, res);
  await rateLimit(req, res);
  
  try {
    // Validate request method
    if (req.method !== 'POST') {
      return res.status(405).json({ 
        status: 'error', 
        message: 'Method not allowed, only POST requests are accepted' 
      });
    }

    // Validate request body
    const { transaction: transactionBase64 } = req.body;
    if (!transactionBase64) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Missing transaction data in request body' 
      });
    }

    // Deserialize the transaction
    let transactionBuffer: Buffer;
    try {
      transactionBuffer = Buffer.from(transactionBase64, 'base64');
    } catch (error) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid transaction format: unable to decode base64 transaction' 
      });
    }

    let transaction: VersionedTransaction;
    try {
      transaction = VersionedTransaction.deserialize(transactionBuffer);
    } catch (error) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid transaction: unable to deserialize transaction data' 
      });
    }

    // Verify we have a versioned transaction (Jupiter API uses these)
    if (!(transaction.message instanceof MessageV0)) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Only versioned transactions (MessageV0) are supported' 
      });
    }

    // Get the sponsor public key
    const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;

    // Prepare to modify the transaction
    const originalMessage = transaction.message;
    const originalAccounts = [...originalMessage.staticAccountKeys];
    
    // Check if the sponsor is already in the account list
    const sponsorKeyIndex = originalAccounts.findIndex(
      key => key.equals(sponsorPubkey)
    );

    let newStaticAccountKeys: PublicKey[];
    let keyIndexMapping: Map<number, number> = new Map();

    // We need to handle accounts carefully to maintain compatibility with instruction indices
    if (sponsorKeyIndex === -1) {
      // If sponsor is not in the list, add it at the beginning and shift all indices
      newStaticAccountKeys = [sponsorPubkey, ...originalAccounts];
      
      // Map original indices to new indices (all shifted by 1)
      originalAccounts.forEach((_, index) => {
        keyIndexMapping.set(index, index + 1);
      });
    } else if (sponsorKeyIndex !== 0) {
      // If sponsor exists but is not first, move it to first position
      newStaticAccountKeys = [
        sponsorPubkey,
        ...originalAccounts.filter((_, i) => i !== sponsorKeyIndex)
      ];
      
      // Map original indices to new indices
      originalAccounts.forEach((_, index) => {
        if (index === sponsorKeyIndex) {
          keyIndexMapping.set(index, 0);
        } else if (index < sponsorKeyIndex) {
          keyIndexMapping.set(index, index + 1);
        } else {
          keyIndexMapping.set(index, index);
        }
      });
    } else {
      // Sponsor is already first, maintain the original accounts order
      newStaticAccountKeys = originalAccounts;
      originalAccounts.forEach((_, index) => {
        keyIndexMapping.set(index, index);
      });
    }

    // Update the header to ensure required signatures includes both sponsor and user
    const newHeader = {
      numRequiredSignatures: Math.max(2, originalMessage.header.numRequiredSignatures),
      numReadonlySignedAccounts: originalMessage.header.numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts: originalMessage.header.numReadonlyUnsignedAccounts
    };

    // Update all instruction account references to reflect our account list changes
    const updatedInstructions = originalMessage.compiledInstructions.map(instruction => {
      // Map the account indices to the new positions
      const newAccountIndexes = instruction.accountKeyIndexes.map(oldIndex => {
        return keyIndexMapping.get(oldIndex) ?? oldIndex;
      });
      
      return {
        ...instruction,
        accountKeyIndexes: newAccountIndexes
      };
    });
    
    // Create a new message with updated accounts and instructions
    const newMessage = new MessageV0({
      header: newHeader,
      staticAccountKeys: newStaticAccountKeys,
      recentBlockhash: originalMessage.recentBlockhash,
      compiledInstructions: updatedInstructions,
      addressTableLookups: originalMessage.addressTableLookups
    });
    
    // Create a new transaction with the modified message
    const newTransaction = new VersionedTransaction(newMessage);
    
    // Initialize signatures array with empty signatures
    // This ensures space for both the sponsor (index 0) and user (index 1) signatures
    newTransaction.signatures = Array(newHeader.numRequiredSignatures)
      .fill(0)
      .map(() => new Uint8Array(64));
    
    // Sign the transaction with the sponsor's key (first signature)
    newTransaction.sign([ENV_SECRET_KEYPAIR]);
    
    // Return the partially signed transaction
    return res.status(200).json({
      status: 'ok',
      transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
      sponsorSignature: base58.encode(newTransaction.signatures[0]),
      message: 'Transaction sponsored successfully. User signature required to complete.'
    });
  } catch (error) {
    console.error('Sponsor transaction error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ 
      status: 'error', 
      message: `Error processing sponsored transaction: ${message}` 
    });
  }
}