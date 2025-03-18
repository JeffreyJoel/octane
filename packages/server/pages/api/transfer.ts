import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction, PublicKey, MessageV0 } from '@solana/web3.js';
import base58 from 'bs58';
import config from '../../../../config.json';
import { cache, connection, cors, rateLimit, ENV_SECRET_KEYPAIR } from '../../src';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await cors(req, res);
  await rateLimit(req, res);

  try {
    // Validate that the request method is POST.
    if (req.method !== 'POST') {
      return res.status(405).json({ status: 'error', message: 'Method not allowed' });
    }

    // Retrieve the raw transaction from the request body.
    const { transaction: transactionBase64 } = req.body;
    if (!transactionBase64) {
      return res.status(400).json({ status: 'error', message: 'Missing transaction' });
    }

    // Deserialize the base64 transaction.
    const transactionBuffer = Buffer.from(transactionBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    // Ensure that the transaction is a versioned transaction (using MessageV0).
    if (!(transaction.message instanceof MessageV0)) {
      return res.status(400).json({
        status: 'error',
        message: 'Only versioned transactions are supported'
      });
    }

    // Extract the current message and sponsor public key.
    const message = transaction.message;
    const sponsorPubkey = ENV_SECRET_KEYPAIR.publicKey;

    // Ensure that the sponsor's public key is the fee payer.
    // The fee payer is determined by the account at index 0.
    // Check if the sponsor is already present in the static account keys.
    const sponsorKeyIndex = message.staticAccountKeys.findIndex(key => key.equals(sponsorPubkey));
    let newStaticAccountKeys = [...message.staticAccountKeys];

    if (sponsorKeyIndex === -1) {
      // If the sponsor is not present, add it at the beginning.
      newStaticAccountKeys.unshift(sponsorPubkey);
    } else if (sponsorKeyIndex !== 0) {
      // If the sponsor exists but is not the first element, reposition it to index 0.
      newStaticAccountKeys.splice(sponsorKeyIndex, 1);
      newStaticAccountKeys.unshift(sponsorPubkey);
    }

    // Create a new header. It is important to have at least one signature (for the sponsor).
    const newHeader = {
      numRequiredSignatures: Math.max(2, message.header.numRequiredSignatures),
      numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts
    };

    // Update instruction account references based on the new ordering.
    const updatedInstructions = message.compiledInstructions.map(instruction => {
      // Map original indices to new indices.
      const accountIndexMapping = message.staticAccountKeys.map((key, oldIndex) => {
        const newIndex = newStaticAccountKeys.findIndex(newKey => newKey.equals(key));
        return { oldIndex, newIndex };
      });

      // Update each account index used in the instruction.
      const newAccountIndexes = instruction.accountKeyIndexes.map(oldIndex => {
        const mapping = accountIndexMapping.find(map => map.oldIndex === oldIndex);
        return mapping ? mapping.newIndex : oldIndex;
      });

      return {
        ...instruction,
        accountKeyIndexes: newAccountIndexes
      };
    });

    // Construct a new message with the updated header, account keys, and instructions.
    const newMessage = new MessageV0({
      header: newHeader,
      staticAccountKeys: newStaticAccountKeys,
      recentBlockhash: message.recentBlockhash,
      compiledInstructions: updatedInstructions,
      addressTableLookups: message.addressTableLookups
    });

    // Create a new versioned transaction with the updated message.
    const newTransaction = new VersionedTransaction(newMessage);

    // Initialize the signatures array with the appropriate length.
    newTransaction.signatures = Array(newHeader.numRequiredSignatures)
      .fill(0)
      .map(() => new Uint8Array(64));

    // Sign the transaction with the sponsor's key to ensure fees are deducted only from the sponsor.
    newTransaction.sign([ENV_SECRET_KEYPAIR]);

    // Return the modified (sponsored) transaction along with the sponsor's signature.
    return res.status(200).json({
      status: 'ok',
      transaction: Buffer.from(newTransaction.serialize()).toString('base64'),
      sponsorSignature: base58.encode(newTransaction.signatures[0])
    });
  } catch (error) {
    console.error('Sponsor transaction error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ status: 'error', message });
  }
}
