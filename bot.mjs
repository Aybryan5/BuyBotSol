import fs from 'fs';
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import { BN } from 'bn.js';
import {
  getMint,
  TOKEN_PROGRAM_ID,
  AccountLayout,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { BondingCurveAccount } from './bounding_curve.mjs';
import 'dotenv/config';
import WebSocket from 'ws';

const { web3 } = anchor;

const DEFAULT_COMMITMENT = 'confirmed';
const GLOBAL_ACCOUNT_SEED = 'global';
const BONDING_CURVE_SEED = 'bonding-curve';

async function main() {
  try {
    const walletJson = JSON.parse(fs.readFileSync('wallet.json'));
    
    const walletKeyPair = Keypair.fromSecretKey(
      Uint8Array.from(Buffer.from(walletJson.privateKey, 'base64'))
    );
console.log(walletKeyPair.publicKey)
    const connection = new Connection(process.env.SOLANA_RPC_NODE_1, {
      wsEndpoint: process.env.SOLANA_WSS_NODE_1,
      WebSocket,
    });

    console.log('Using RPC endpoint:', process.env.SOLANA_RPC_NODE1);

    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(walletKeyPair), {
      commitment: DEFAULT_COMMITMENT,
    });

    const idl = JSON.parse(fs.readFileSync('./idl.json'));
    const programId = new PublicKey(idl.metadata.address);
    const program = new anchor.Program(idl, programId, provider);

    console.log(`Wallet public key: ${walletKeyPair.publicKey.toBase58()}`);

    const CONTRACT_ADDRESS = new PublicKey('GFokG8fZUrtLvYbZvuQAMctjUytd4VuAttmEnbuUpump');

    const mintInfo = await getMint(connection, CONTRACT_ADDRESS);
    console.log('Mint Information:', mintInfo);

    async function getFirstHolder(tokenMintPubKey, connection) {
      const tokenAccounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
          {
            dataSize: AccountLayout.span,
          },
          {
            memcmp: {
              offset: AccountLayout.offsetOf('mint'),
              bytes: tokenMintPubKey.toBase58(),
            },
          },
        ],
      });

      console.log(`Found ${tokenAccounts.length} token accounts.`);

      if (tokenAccounts.length === 0) {
        console.log('No holders found.');
        return null;
      }

      tokenAccounts.sort((a, b) => {
        const balanceA = BigInt(a.account.data.parsed.info.tokenAmount.amount);
        const balanceB = BigInt(b.account.data.parsed.info.tokenAmount.amount);
        return balanceB > balanceA ? 1 : balanceB < balanceA ? -1 : 0;
      });

      const firstHolderAccount = tokenAccounts[0].account.data.parsed.info;
      const firstHolderAddress = new PublicKey(firstHolderAccount.owner);

      return firstHolderAddress;
    }

    function getBondingCurvePDA(CONTRACT_ADDRESS, programId) {
      return PublicKey.findProgramAddressSync(
        [Buffer.from(BONDING_CURVE_SEED), CONTRACT_ADDRESS.toBuffer()],
        programId
      )[0];
    }

    async function getBondingCurveAccount(CONTRACT_ADDRESS, connection, programId, commitment = DEFAULT_COMMITMENT) {
      const tokenAccount = await connection.getAccountInfo(getBondingCurvePDA(CONTRACT_ADDRESS, programId), commitment);
      if (!tokenAccount) {
        return null;
      }
      return BondingCurveAccount.fromBuffer(tokenAccount.data);
    }

    const associatedBondingCurve = await getAssociatedTokenAddress(
      CONTRACT_ADDRESS,
      getBondingCurvePDA(CONTRACT_ADDRESS, programId),
      true
    );

    async function ensureAssociatedTokenAccountExists(connection, walletKeyPair, CONTRACT_ADDRESS) {
      const associatedTokenAddress = await getAssociatedTokenAddress(
        CONTRACT_ADDRESS,
        walletKeyPair.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

      if (!accountInfo) {
        console.log('Creating associated token account...');
        const instruction = createAssociatedTokenAccountInstruction(
          walletKeyPair.publicKey,
          associatedTokenAddress,
          walletKeyPair.publicKey,
          CONTRACT_ADDRESS,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const transaction = new web3.Transaction().add(instruction);
        const signature = await web3.sendAndConfirmTransaction(connection, transaction, [walletKeyPair]);
        console.log('Associated token account created:', signature);
      } else {
        console.log('Associated token account already exists.');
      }

      return associatedTokenAddress;
    }

    const associatedUser = await ensureAssociatedTokenAccountExists(
      connection,
      walletKeyPair,
      CONTRACT_ADDRESS
    );
    console.log('Associated user:', associatedUser.toBase58());

    async function getGlobalAccount(connection, program, commitment = DEFAULT_COMMITMENT) {
      const [globalAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_ACCOUNT_SEED)],
        programId
      );

      const tokenAccount = await connection.getAccountInfo(globalAccountPDA, commitment);

      if (!tokenAccount) {
        throw new Error('Global account not found');
      }

      return globalAccountPDA;
    }

    async function buyTokens(connection, program, walletKeyPair) {
      const lamports = 0.020 * LAMPORTS_PER_SOL;
      const solAmount = new BN(lamports.toString()); // Using BN for SOL amount

      console.log('solAmount:', solAmount.toString());

      let bondingCurveAccount = await getBondingCurveAccount(CONTRACT_ADDRESS, connection, programId, 'confirmed');
      if (!bondingCurveAccount) {
        throw new Error('BondingCurveAccount is undefined');
      }

      // Ensure getBuyPrice uses BN correctly
      let buyAmount = new BN(bondingCurveAccount.getBuyPrice(solAmount.toString())); // Convert to BN if necessary

      const PRIORITY_RATE = new BN(400000);

      console.log('solAmount:', solAmount.toString());
      console.log('Price:', buyAmount.toString());

      const firstHolder = await getFirstHolder(CONTRACT_ADDRESS, connection);
      if (!firstHolder) {
        throw new Error('No first holder found.');
      }

      const PRIORITY_FEE_INSTRUCTIONS = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_RATE });

      const globalAccount = await getGlobalAccount(connection, program);

      try {
        // Check variables here to prevent undefined errors
        if (!associatedBondingCurve) throw new Error('associatedBondingCurve is undefined');
        if (!associatedUser) throw new Error('associatedUser is undefined');
        if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS is undefined');
        if (!firstHolder) throw new Error('firstHolder is undefined');
        if (!programId) throw new Error('programId is undefined');
        if (!globalAccount) throw new Error('globalAccount is undefined');

        // Create buy instruction using the 'buy' method of your program
        const solAmountBN = new BN(solAmount.toString() + 20000 );
        const BuyAmountBN = new BN(buyAmount.toString())
        console.log()
        const buyInstruction = program.instruction.buy(
          BuyAmountBN, // Amount in BN
          solAmountBN, // Amount to pay in BN
          {
            accounts: {
              global: globalAccount,
              feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
              associatedBondingCurve: associatedBondingCurve,
              associatedUser: associatedUser,
              mint: CONTRACT_ADDRESS,
              bondingCurve: firstHolder,
              user: walletKeyPair.publicKey,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: anchor.web3.SYSVAR_RENT_PUBKEY,
              eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
              program: programId,
            },
            remainingAccounts: [],
            signers: [walletKeyPair.publicKey],
          }
        );

        // Build the full list of instructions
                // Build the full list of instructions
                const instructions = [
                  buyInstruction,
                  PRIORITY_FEE_INSTRUCTIONS, // Add priority instructions here if needed
                ];
        
                // Get the latest blockhash for the transaction
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        
                // Create the transaction message using the TransactionMessage class
                const message = new TransactionMessage({
                  payerKey: walletKeyPair.publicKey,
                  recentBlockhash: blockhash,
                  lastValidBlockHeight: lastValidBlockHeight,
                  instructions,
                }).compileToV0Message();
        
                // Create the transaction using the compiled message
                const transaction = new VersionedTransaction(message);
                transaction.sign([walletKeyPair]);
        
                // Send the signed transaction to the blockchain
                const serializedTransaction = transaction.serialize();
                const txId = await connection.sendRawTransaction(serializedTransaction, {
                  skipPreflight: true,
                });
        
                console.log('Transaction successful with txId:', txId);
        
                return txId; // Return transaction ID for chaining
        
              } catch (error) {
                if (error.name === 'TransactionExpiredTimeoutError') {
                  console.error('Transaction expired, retrying...');
                  throw error; // Rethrow the error to retry the transaction
                } else {
                  console.error('Error in buyTokens:', error);
                  throw error; // Rethrow the error to handle at the main level
                }
              }
            }
        
            async function sellAllTokens(connection, program, walletKeyPair) {
              try {
                const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeyPair.publicKey, {
                  programId: TOKEN_PROGRAM_ID,
                });
        
                if (tokenAccounts.value.length === 0) {
                  console.log('No token accounts found to sell.');
                  return;
                }
        
                const globalAccount = await getGlobalAccount(connection, program);
                const firstHolder = await getFirstHolder(CONTRACT_ADDRESS, connection);
        
                if (!firstHolder) {
                  console.error('No first holder found.');
                  return;
                }
        
                for (const account of tokenAccounts.value) {
                  try {
                    const accountInfo = account.account.data.parsed.info;
        
                    if (!accountInfo || !accountInfo.tokenAmount || !accountInfo.tokenAmount.amount) {
                      console.log(`Skipping account ${account.pubkey} because token amount is undefined or 0.`);
                      continue;
                    }
        
                    const amountToSell = new BN(accountInfo.tokenAmount.amount);
        
                    if (amountToSell.isZero()) {
                      console.log(`Skipping account ${account.pubkey} because amount to sell is 0.`);
                      continue;
                    }
                    const amountToSell1 = new BN(accountInfo.tokenAmount.amount - 1000)
                    const PRIORITY_RATE = new BN(600000);
                    const PRIORITY_FEE_INSTRUCTIONS = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_RATE });
                    const minsol = new BN(0)
        
                    // Create sell instruction using the 'sell' method of your program
                    const sellInstruction = program.instruction.sell(
                      amountToSell1, // Amount in BN
                      minsol,
                      {
                        accounts: {
                          global: globalAccount,
                          feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
                          associatedBondingCurve: associatedBondingCurve,
                          associatedUser: associatedUser,
                          mint: CONTRACT_ADDRESS,
                          bondingCurve: firstHolder,
                          user: walletKeyPair.publicKey,
                          systemProgram: SystemProgram.programId,
                          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                          tokenProgram: TOKEN_PROGRAM_ID,
                          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                          eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                          program: programId,
                        },
                        remainingAccounts: [],
                        signers: [walletKeyPair.publicKey],
                      }
                    );
        
                    // Build the full list of instructions
                    const instructions = [
                      sellInstruction,
                      PRIORITY_FEE_INSTRUCTIONS, // Add priority instructions here if needed
                    ];
        
                    // Get the latest blockhash for the transaction
                    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        
                    // Create the transaction message using the TransactionMessage class
                    const message = new TransactionMessage({
                      payerKey: walletKeyPair.publicKey,
                      recentBlockhash: blockhash,
                      lastValidBlockHeight: lastValidBlockHeight,
                      instructions,
                    }).compileToV0Message();
        
                    // Create the transaction using the compiled message
                    const transaction = new VersionedTransaction(message);
                    transaction.sign([walletKeyPair]);
        
                    // Send the signed transaction to the blockchain
                    const serializedTransaction = transaction.serialize();
                    const txId = await connection.sendRawTransaction(serializedTransaction, {
                      skipPreflight: true,
                    });
        
                    console.log('Transaction successful with txId:', txId);
        
                  } catch (error) {
                    if (error.name === 'TransactionExpiredTimeoutError') {
                      console.error('Transaction expired, retrying...');
                      throw error; // Rethrow the error to retry the transaction
                    } else {
                      console.error('Error in sellAllTokens:', error);
                      throw error; // Rethrow the error to handle at the main level
                    }
                  }
                }
              } catch (error) {
                console.error('Error in sellAllTokens:', error);
                throw error; // Rethrow the error to handle at the main level
              }
            } 
            async function runCycle(connection, program, walletKeyPair) {
              const NUM_SUCCESSFUL_BUYS_BEFORE_SELL = 2; // Nombre d'achats réussis avant de vendre
              let successfulBuyCount = 0;
              try {
                
                while (true) {
                  try {
                    
              
                  
              
                    // Execute de transaction order
                    
                    successfulBuyCount++;
            
                    console.log(`Number of successful order : ${successfulBuyCount}`);
            
                    // If we did 3 successfull attempt then 
                    if (successfulBuyCount === NUM_SUCCESSFUL_BUYS_BEFORE_SELL) {
                      await sellAllTokens(connection, program, walletKeyPair);
                      console.log('Sell order successfull');
                      successfulBuyCount = 0; // Reinitialize the count
                    }
            
                    await delay(2500); // delay between transaction to not flood solana system
            
                  } catch (error) {
                    console.error('Error while buying :', error);
                    
                  }
                }
              } catch (error) {
                console.error('Error in RunCycle:', error);
                throw error; // Rethrow l'erreur pour la gérer au niveau principal
              }
            }
            
            // Fonction pour simuler un délai
            function delay(ms) {
              return new Promise(resolve => setTimeout(resolve, ms));
            }
            
            await runCycle(connection, program, walletKeyPair);
            console.log('Program finished.');
        
          } catch (error) {
            console.error('Error running program:', error);
          }
        }
        
        main().then(() => {
          console.log('Program finished.');
        }).catch((error) => {
          console.error('Error running program:', error);
        });
