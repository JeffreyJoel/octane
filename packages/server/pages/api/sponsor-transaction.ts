import { NextApiRequest, NextApiResponse } from 'next';
import { VersionedTransaction, Transaction, TransactionMessage } from '@solana/web3.js';
import { signWithTokenFee, core } from '@solana/octane-core';
import config from '../../../../config.json';
import {
    cache,
    connection,
    ENV_SECRET_KEYPAIR,
    cors,
    rateLimit
} from '../../src';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    await cors(req, res);
    await rateLimit(req, res);
  try {
    const { transaction: swapTransaction, userPublicKey } = req.body;
    
    // Deserialize transaction
    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64")
    );

    // Convert to legacy transaction for Octane compatibility
    const legacyTx = new Transaction({
      feePayer: tx.message.staticAccountKeys[0],
      ...tx.message
    });

    // Apply fee sponsorship
    const { transaction: sponsoredTx } = await signWithTokenFee(
      connection,
      legacyTx,
      ENV_SECRET_KEYPAIR,
      config.maxSignatures,
      config.lamportsPerSignature,
      config.endpoints.transfer.tokens.map(core.TokenFee.fromSerializable),
      cache
    );

    // Convert back to VersionedTransaction
    const versionedTx = new VersionedTransaction(
      new TransactionMessage(sponsoredTx).compileToV0Message()
    );

    res.status(200).json({
      transaction: Buffer.from(versionedTx.serialize()).toString("base64")
    });
    
  } catch (error) {
    res.status(400).json({ error: "Transaction sponsorship failed" });
  }
}