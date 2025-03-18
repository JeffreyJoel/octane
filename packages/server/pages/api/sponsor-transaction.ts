import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction, MessageV0 } from '@solana/web3.js';
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

        // Check if the transaction is versioned
        if (transaction.message instanceof MessageV0) {
            // For versioned transactions, we need to handle lookup tables
            // Get the static account keys
            const staticAccountKeys = transaction.message.staticAccountKeys;
            
            // Find sponsor index using staticAccountKeys directly
            const sponsorIndex = staticAccountKeys.findIndex(
                (key:any) => key.equals(ENV_SECRET_KEYPAIR.publicKey)
            );
            
            if (sponsorIndex === -1) {
                throw new Error('Sponsor not found in transaction signers');
            }
            
            // Sign the transaction
            transaction.sign([ENV_SECRET_KEYPAIR]);
            
            const sponsorSignature = transaction.signatures[sponsorIndex];
            
            // Return the sponsored transaction
            return res.status(200).json({
                status: 'ok',
                transaction: Buffer.from(transaction.serialize()).toString('base64'),
                sponsorSignature: base58.encode(sponsorSignature)
            });
        } else {
            // For legacy transactions, use the old approach
            const accountKeys = transaction.message.getAccountKeys();
            
            if (!accountKeys) {
                throw new Error('No account keys found in transaction');
            }
            
            const sponsorIndex = accountKeys.staticAccountKeys.findIndex(
                (key) => key.equals(ENV_SECRET_KEYPAIR.publicKey)
            );
            
            if (sponsorIndex === -1) {
                throw new Error('Sponsor not found in transaction signers');
            }
            
            transaction.sign([ENV_SECRET_KEYPAIR]);
            
            const sponsorSignature = transaction.signatures[sponsorIndex];
            
            return res.status(200).json({
                status: 'ok',
                transaction: Buffer.from(transaction.serialize()).toString('base64'),
                sponsorSignature: base58.encode(sponsorSignature)
            });
        }
    } catch (error) {
        console.error('Sponsor transaction error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ status: 'error', message });
    }
}