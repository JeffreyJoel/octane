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
        const originalTransaction = VersionedTransaction.deserialize(transactionBuffer);

        // For versioned transactions (which Jupiter uses)
        if (originalTransaction.message instanceof MessageV0) {
            const originalMessage = originalTransaction.message;
            const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;
            
            // First, simulate the original transaction to ensure it's valid
            console.log("Simulating original transaction to validate...");
            try {
                const simulation = await connection.simulateTransaction(originalTransaction);
                if (simulation.value.err) {
                    console.error("Original transaction simulation failed:", simulation.value.err);
                    return res.status(400).json({ 
                        status: 'error', 
                        message: `Original transaction is invalid: ${JSON.stringify(simulation.value.err)}` 
                    });
                }
            } catch (simError) {
                console.error("Error simulating original transaction:", simError);
            }
            
            // Get the original fee payer (first signer)
            const originalFeePayer = originalMessage.staticAccountKeys[0];
            console.log("Original fee payer:", originalFeePayer.toBase58());
            
            // Create new account keys array with sponsor as the fee payer
            const newStaticAccountKeys = [
                sponsorPubkey, // Sponsor is the new fee payer
                ...originalMessage.staticAccountKeys // Keep all original accounts in their order
            ];
            
            // Create account index mapping (all original accounts shift by 1)
            const accountIndexMap = new Map();
            for (let i = 0; i < originalMessage.staticAccountKeys.length; i++) {
                accountIndexMap.set(i, i + 1);
            }
            
            // Map the instructions with updated account indices
            const newInstructions = originalMessage.compiledInstructions.map(instruction => {
                return {
                    programIdIndex: accountIndexMap.get(instruction.programIdIndex),
                    accountKeyIndexes: instruction.accountKeyIndexes.map(index => 
                        accountIndexMap.get(index)
                    ),
                    data: instruction.data // Keep the same data
                };
            });
            
            // Create a new header with adjusted signature requirements
            const newHeader = {
                numRequiredSignatures: originalMessage.header.numRequiredSignatures + 1, // Add sponsor signature
                numReadonlySignedAccounts: originalMessage.header.numReadonlySignedAccounts,
                numReadonlyUnsignedAccounts: originalMessage.header.numReadonlyUnsignedAccounts
            };
            
            // Create a new message
            const newMessage = new MessageV0({
                header: newHeader,
                staticAccountKeys: newStaticAccountKeys,
                recentBlockhash: originalMessage.recentBlockhash,
                compiledInstructions: newInstructions,
                addressTableLookups: originalMessage.addressTableLookups
            });
            
            // Create a new transaction with the new message
            const newTransaction = new VersionedTransaction(newMessage);
            
            // Initialize signatures array with empty signatures
            newTransaction.signatures = new Array(newHeader.numRequiredSignatures).fill(0).map(() => new Uint8Array(64));
            
            // Sign the transaction with the sponsor key
            newTransaction.sign([ENV_SECRET_KEYPAIR]);
            
            // Simulate the new transaction before returning it
            console.log("Simulating sponsored transaction...");
            try {
                const simulation = await connection.simulateTransaction(newTransaction, {
                    sigVerify: false, // Skip signature verification for simulation
                });
                
                if (simulation.value.err) {
                    console.error("Sponsored transaction simulation failed:", simulation.value.err);
                    console.error("Simulation logs:", simulation.value.logs);
                    return res.status(400).json({ 
                        status: 'error', 
                        message: `Sponsored transaction is invalid: ${JSON.stringify(simulation.value.err)}`,
                        logs: simulation.value.logs
                    });
                }
                
                console.log("Simulation successful");
            } catch (simError) {
                console.error("Error simulating sponsored transaction:", simError);
                // Continue even if simulation fails here - we'll let the frontend handle it
            }
            
            // Return the sponsored transaction
            return res.status(200).json({
                status: 'ok',
                transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
                sponsorSignature: base58.encode(newTransaction.signatures[0]),
                message: 'Transaction sponsored successfully.'
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