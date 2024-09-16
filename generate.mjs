import fs from 'fs';
import { Keypair } from '@solana/web3.js';

// Generate a new keypair
const wallet = Keypair.generate();

// Save the keypair in base64
const privateKey = Buffer.from(wallet.secretKey).toString('base64');
fs.writeFileSync('wallet.json', JSON.stringify({ privateKey }));

console.log(`Wallet public key: ${wallet.publicKey.toBase58()}`);
