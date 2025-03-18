import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction, PublicKey, MessageV0 } from '@solana/web3.js';
import base58 from 'bs58';
import config from '../../../../config.json';
import { cache, connection, cors, rateLimit, ENV_SECRET_KEYPAIR } from '../../src';

// Modify your backend handler
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
            // Get the current message and sponsor key
            const message = transaction.message;
            const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;
            
            // IMPORTANT: Instead of reordering accounts, we add the sponsor
            // as a fee payer while preserving the original account order
            // This way we don't break instruction account references
            
            // First, check if sponsor is already in the accounts list
            const sponsorKeyIndex = message.staticAccountKeys.findIndex(
                key => key.equals(sponsorPubkey)
            );
            
            // We'll create a list of accounts with sponsor first, followed by original accounts
            // But we need to be careful with instruction indices
            const newStaticAccountKeys = [...message.staticAccountKeys];
            
            // If sponsor is not in the account list, add it at index 0
            if (sponsorKeyIndex === -1) {
                newStaticAccountKeys.unshift(sponsorPubkey);
            } else if (sponsorKeyIndex !== 0) {
                // If the sponsor is in the list but not first, move it to first position
                newStaticAccountKeys.splice(sponsorKeyIndex, 1); // Remove from current position
                newStaticAccountKeys.unshift(sponsorPubkey); // Add to beginning
            }
            
            // Create a new header with required signatures
            // Important: We need to make sure the number of required signatures is correct
            const newHeader = {
                numRequiredSignatures: Math.max(1, message.header.numRequiredSignatures),
                numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
                numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts
            };
            
            // Now we need to update all instruction account references
            // to reflect our account list changes
            const updatedInstructions = message.compiledInstructions.map(instruction => {
                // Create a mapping of old indices to new indices
                const accountIndexMapping = message.staticAccountKeys.map((key, oldIndex) => {
                    // Find where this key is in the new accounts list
                    const newIndex = newStaticAccountKeys.findIndex(newKey => newKey.equals(key));
                    return { oldIndex, newIndex };
                });
                
                // Update the accountKeyIndexes to use new indices
                const newAccountIndexes = instruction.accountKeyIndexes.map(oldIndex => {
                    const mapping = accountIndexMapping.find(map => map.oldIndex === oldIndex);
                    return mapping ? mapping.newIndex : oldIndex;
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
                recentBlockhash: message.recentBlockhash,
                compiledInstructions: updatedInstructions,
                addressTableLookups: message.addressTableLookups
            });
            
            // Create a new transaction with the modified message
            const newTransaction = new VersionedTransaction(newMessage);
            
            // Initialize signatures array matching the required signature count
            newTransaction.signatures = Array(newHeader.numRequiredSignatures)
                .fill(0)
                .map(() => new Uint8Array(64));
            
            // Sign the transaction with the sponsor's key
            newTransaction.sign([ENV_SECRET_KEYPAIR]);
            
            // Return the sponsored transaction
            return res.status(200).json({
                status: 'ok',
                transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
                sponsorSignature: base58.encode(newTransaction.signatures[0])
            });
        } else {
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