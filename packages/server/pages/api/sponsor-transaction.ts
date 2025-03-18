import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction } from '@solana/web3.js';
import base58 from 'bs58';
import config from '../../../../config.json';
import { cache, connection, cors, rateLimit } from '../../src';

// Set this in your environment variables
const SPONSOR_PRIVATE_KEY = base58.decode(process.env.SECRET_KEY || '');

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

        // Sponsor signs the transaction
        const sponsorSignature = transaction.sign([SPONSOR_PRIVATE_KEY]);

        // Serialize the sponsored transaction
        const sponsoredTransaction = transaction.serialize();

        // Return the sponsored transaction
        res.status(200).json({
            status: 'ok',
            transaction: sponsoredTransaction.toString('base64'),
            sponsorSignature: base58.encode(sponsorSignature)
        });

    } catch (error) {
        console.error('Sponsor transaction error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(400).json({ status: 'error', message });
    }
}