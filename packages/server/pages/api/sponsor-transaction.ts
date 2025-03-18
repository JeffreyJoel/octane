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
            // Get the current message
            const message = transaction.message;
            
            // Add the sponsor as a fee payer for the transaction
            const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;

            const newHeader = {
                // Assuming we want 2 signers: the sponsor and the user
                numRequiredSignatures: 2,
                numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
                numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts
              };
            
            // Create a new message with the sponsor as a fee payer (first in the list)
            const newMessage = new MessageV0({
                header: newHeader,
                staticAccountKeys: [
                    sponsorPubkey,
                    ...message.staticAccountKeys.filter(key => !key.equals(sponsorPubkey))
                ],
                recentBlockhash: message.recentBlockhash,
                compiledInstructions: message.compiledInstructions,
                addressTableLookups: message.addressTableLookups
            });
            
            // Create a new transaction with the modified message
            const newTransaction = new VersionedTransaction(newMessage);
            
            // Initialize signatures array with empty signatures for each key
            // VersionedTransaction.signatures is an array of Uint8Arrays
            newTransaction.signatures = Array.from(
                { length: newHeader.numRequiredSignatures},
                () => new Uint8Array(64)
              );
            
            // Sign the transaction with the sponsor's key
            // This will update the first signature in the array (the fee payer position)
            newTransaction.sign([ENV_SECRET_KEYPAIR]);
            
            // Return the sponsored transaction
            return res.status(200).json({
                status: 'ok',
                transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
                sponsorSignature: base58.encode(newTransaction.signatures[0]) // Get first signature (sponsor's)
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