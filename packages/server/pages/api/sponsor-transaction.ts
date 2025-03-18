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
            
            // Assuming the original transaction has one signer (the user)
            // Get the user's public key (should be the first signer in original transaction)
            const userPubkey = originalMessage.staticAccountKeys[0];
            
            // Create a new header
            // The sponsor will be the only fee-paying signer
            // The user will be a required signer but not pay fees
            const newHeader = {
                numRequiredSignatures: 2, // Exactly two signers: sponsor and user
                numReadonlySignedAccounts: 1, // User is a readonly signer (doesn't pay fees)
                numReadonlyUnsignedAccounts: originalMessage.header.numReadonlyUnsignedAccounts
            };
            
            // Create the new account key list:
            // 1. Sponsor as first fee-paying signer
            // 2. User as readonly signed account
            // 3. All other accounts from original transaction (excluding the user if already present)
            const newStaticAccountKeys = [
                // Sponsor as the fee-paying signer
                sponsorPubkey,
                
                // User as readonly signed account
                userPubkey,
                
                // All other accounts (excluding user since we already included them)
                ...originalMessage.staticAccountKeys.slice(1).filter(key => !key.equals(sponsorPubkey))
            ];

            // Create a new message with the modified account keys and header
            const newMessage = new MessageV0({
                header: newHeader,
                staticAccountKeys: newStaticAccountKeys,
                recentBlockhash: originalMessage.recentBlockhash,
                compiledInstructions: originalMessage.compiledInstructions.map(instruction => {
                    // Adjust instruction account indexes to match the new key arrangement
                    return {
                        ...instruction,
                        accountKeyIndexes: instruction.accountKeyIndexes.map(index => {
                            // If the index was pointing to the user's public key (index 0 in original transaction)
                            if (index === 0) {
                                return 1; // User is now at index 1
                            }
                            
                            // For all other accounts, adjust for the insertion of the sponsor
                            // Need to consider if the sponsor was already in the original keys
                            const originalKey = originalMessage.staticAccountKeys[index];
                            const newIndex = newStaticAccountKeys.findIndex(key => key.equals(originalKey));
                            return newIndex >= 0 ? newIndex : index + 1; // +1 because sponsor is inserted at index 0
                        })
                    };
                }),
                addressTableLookups: originalMessage.addressTableLookups
            });
            
            // Create a new transaction with the modified message
            const newTransaction = new VersionedTransaction(newMessage);
            
            // Initialize signatures array with empty signatures for both signers
            newTransaction.signatures = [
                new Uint8Array(64), // Sponsor's signature placeholder
                new Uint8Array(64)  // User's signature placeholder
            ];
            
            // Sign the transaction with the sponsor's key
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