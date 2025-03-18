import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction } from '@solana/web3.js';
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

        // Verify the transaction is versioned
        if (!transaction.version) {
            return res.status(400).json({ status: 'error', message: 'Invalid transaction version' });
        }

        transaction.sign([ENV_SECRET_KEYPAIR]);

        // Get the sponsor's signature from the transaction
        const sponsorIndex = transaction.message.accountKeys.findIndex(
          (key: any) => key.equals(ENV_SECRET_KEYPAIR.publicKey)
        );
        
        if (sponsorIndex === -1) {
          throw new Error('Sponsor not found in transaction signers');
        }
      
        const sponsorSignature = transaction.signatures[sponsorIndex];

        // Return the sponsored transaction
        res.status(200).json({
            status: 'ok',
            transaction: transaction.serialize(),
            sponsorSignature: base58.encode(sponsorSignature)
        });

    } catch (error) {
        console.error('Sponsor transaction error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ status: 'error', message });
    }
}