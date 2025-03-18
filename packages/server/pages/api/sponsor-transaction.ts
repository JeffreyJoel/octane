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

        try {
            // Deserialize the transaction
            const transactionBuffer = Buffer.from(transactionBase64, 'base64');
            const transaction = VersionedTransaction.deserialize(transactionBuffer);

            // Debug logging
            console.log("Transaction type:", transaction.version);
            console.log("Static account keys count:", 
                transaction.message instanceof MessageV0 ? 
                transaction.message.staticAccountKeys.length : 
                "Not MessageV0");

            // For versioned transactions (which Jupiter uses)
            if (transaction.message instanceof MessageV0) {
                // Get the original message
                const originalMessage = transaction.message;
                
                // Get the sponsor's public key
                const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;
                
                // Get the first signer's public key from the original transaction
                // This is typically the user's public key
                if (originalMessage.staticAccountKeys.length === 0) {
                    throw new Error("Transaction has no account keys");
                }
                
                const userPubkey = originalMessage.staticAccountKeys[0];
                
                // Debug logging
                console.log("User pubkey:", userPubkey.toBase58());
                console.log("Sponsor pubkey:", sponsorPubkey.toBase58());
                
                // Create a new header with two signers
                const newHeader = {
                    numRequiredSignatures: 2, // Two signers: sponsor and user
                    numReadonlySignedAccounts: 1, // User is a readonly signer (doesn't pay fees)
                    numReadonlyUnsignedAccounts: originalMessage.header.numReadonlyUnsignedAccounts
                };
                
                // Create a new list of account keys with sponsor first
                const newStaticAccountKeys = [
                    // Sponsor as the fee-paying signer
                    sponsorPubkey
                ];
                
                // Add user key if not the same as sponsor (should never be the same in practice)
                if (!userPubkey.equals(sponsorPubkey)) {
                    newStaticAccountKeys.push(userPubkey);
                }
                
                // Add the rest of the original keys (excluding the user and sponsor)
                originalMessage.staticAccountKeys.forEach(key => {
                    if (!key.equals(userPubkey) && !key.equals(sponsorPubkey)) {
                        newStaticAccountKeys.push(key);
                    }
                });

                // Debug logging
                console.log("New static account keys count:", newStaticAccountKeys.length);
                
                // Create a map for finding indices of accounts
                const keyToNewIndex = new Map();
                newStaticAccountKeys.forEach((key, index) => {
                    keyToNewIndex.set(key.toBase58(), index);
                });
                
                // Map from old indices to new indices
                const mapAccountIndex = (oldIndex: number): number => {
                    const oldKey = originalMessage.staticAccountKeys[oldIndex];
                    const newIndex = keyToNewIndex.get(oldKey.toBase58());
                    
                    if (newIndex === undefined) {
                        throw new Error(`Could not find new index for account key at old index ${oldIndex}`);
                    }
                    
                    return newIndex;
                };
                
                // Handle instructions carefully
                const newInstructions = originalMessage.compiledInstructions.map(instruction => {
                    try {
                        return {
                            programIdIndex: mapAccountIndex(instruction.programIdIndex),
                            accountKeyIndexes: instruction.accountKeyIndexes.map(mapAccountIndex),
                            data: instruction.data
                        };
                    } catch (err) {
                        console.error("Error mapping instruction:", err);
                        throw err;
                    }
                });
                
                // Create the new message
                const newMessage = new MessageV0({
                    header: newHeader,
                    staticAccountKeys: newStaticAccountKeys,
                    recentBlockhash: originalMessage.recentBlockhash,
                    compiledInstructions: newInstructions,
                    addressTableLookups: originalMessage.addressTableLookups
                });
                
                // Create a new transaction with our modified message
                const newTransaction = new VersionedTransaction(newMessage);
                
                // Initialize signatures array with empty signatures
                newTransaction.signatures = Array(newHeader.numRequiredSignatures).fill(0)
                    .map(() => new Uint8Array(64));
                
                // Sign with the sponsor's key (first position)
                newTransaction.sign([ENV_SECRET_KEYPAIR]);
                
                // Return the sponsored transaction
                return res.status(200).json({
                    status: 'ok',
                    transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
                    sponsorSignature: base58.encode(newTransaction.signatures[0])
                });
            } else {
                // For legacy transactions
                return res.status(400).json({ 
                    status: 'error', 
                    message: 'Only versioned transactions are supported' 
                });
            }
        } catch (error) {
            console.error('Transaction processing error:', error);
            throw error;
        }
    } catch (error) {
        console.error('Sponsor transaction error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ status: 'error', message });
    }
}