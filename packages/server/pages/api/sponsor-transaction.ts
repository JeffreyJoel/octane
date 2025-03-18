import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction, PublicKey, MessageV0 } from '@solana/web3.js';
import base58 from 'bs58';
import config from '../../../../config.json';
import { cache, connection, cors, rateLimit, ENV_SECRET_KEYPAIR } from '../../src';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    await cors(req, res);
    await rateLimit(req, res);
    
    try {
        // Validate request method
        if (req.method !== 'POST') {
            return res.status(405).json({ status: 'error', message: 'Method not allowed' });
        }

        // Get raw transaction from request body
        const { transaction: transactionBase64 } = req.body;
        if (!transactionBase64) {
            return res.status(400).json({ status: 'error', message: 'Missing transaction' });
        }

        // Deserialize the transaction
        const transactionBuffer = Buffer.from(transactionBase64, 'base64');
        const transaction = VersionedTransaction.deserialize(transactionBuffer);

        // For versioned transactions (which Jupiter uses)
        if (transaction.message instanceof MessageV0) {
            // Get the original message
            const originalMessage = transaction.message;
            
            // Get the sponsor's public key
            const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;

            // Get all original signers from the transaction
            const originalSigners = originalMessage.staticAccountKeys.slice(
                0,
                originalMessage.header.numRequiredSignatures
            );
            
            // Create a new header where only the sponsor is a fee-paying signer
            // All other signers are required but won't pay fees
            const newHeader = {
                numRequiredSignatures: originalMessage.header.numRequiredSignatures + 1, // +1 for the sponsor
                numReadonlySignedAccounts: originalMessage.header.numReadonlySignedAccounts + originalSigners.length, // All original signers become readonly
                numReadonlyUnsignedAccounts: originalMessage.header.numReadonlyUnsignedAccounts
            };
            
            // Rearrange account keys:
            // 1. Sponsor as the first and only fee-paying signer
            // 2. Original signers as readonly signed accounts
            // 3. All other accounts unchanged
            const newStaticAccountKeys = [
                // Sponsor as the only fee-paying signer
                sponsorPubkey,
                
                // Original signers now as readonly signed accounts
                ...originalSigners,
                
                // Rest of the accounts remain the same
                ...originalMessage.staticAccountKeys.slice(
                    originalMessage.header.numRequiredSignatures
                )
            ];

            // Create a new message with the modified account keys and header
            const newMessage = new MessageV0({
                header: newHeader,
                staticAccountKeys: newStaticAccountKeys,
                recentBlockhash: originalMessage.recentBlockhash,
                compiledInstructions: originalMessage.compiledInstructions.map(instruction => {
                    return {
                      ...instruction,
                      accountKeyIndexes: instruction.accountKeyIndexes.map(index => {
                        // If the index was a signer in the original transaction
                        if (index < originalMessage.header.numRequiredSignatures) {
                          return index + 1; // +1 because sponsor is inserted at index 0
                        } 
                        // If the index was not a signer in the original transaction
                        else {
                          // We need to shift by 1 (sponsor) but not by the signers length
                          // because the signers were already accounted for in the original index
                          return index + 1;
                        }
                      })
                    };
                  }),
                addressTableLookups: originalMessage.addressTableLookups
            });
            
            // Create a new transaction with the modified message
            const newTransaction = new VersionedTransaction(newMessage);
            
            // Initialize signatures array with empty signatures
            newTransaction.signatures = Array.from(
                { length: newHeader.numRequiredSignatures },
                () => new Uint8Array(64)
            );
            
            // Sign the transaction with the sponsor's key (first signature)
            newTransaction.sign([ENV_SECRET_KEYPAIR]);
            
            // Return the sponsored transaction
            return res.status(200).json({
                status: 'ok',
                transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
                sponsorSignature: base58.encode(newTransaction.signatures[0]), // Sponsor's signature
                message: 'Transaction sponsored successfully. Only the sponsor will pay fees.'
            });
        } else {
            // For legacy transactions
            return res.status(400).json({ 
                status: 'error', 
                message: 'Only versioned transactions are supported' 
            });
        }
    } catch (error) {
        console.error('Sponsor transaction error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ status: 'error', message });
    }
}