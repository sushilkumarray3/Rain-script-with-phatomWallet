import axios from 'axios';
import crypto from 'crypto-js';

import {
  Connection,
  Ed25519Program,
  PublicKey,
  SendTransactionError,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';

import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import BN from 'bn.js';
import { mainIdl } from './solana/idl/mainIdl';

// ───────────────────────────────────────────────────────────────────────────────
// Wallet adapter (from App.tsx)
// ───────────────────────────────────────────────────────────────────────────────
type WalletAdapter = {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
  signMessage?(bytes: Uint8Array): Promise<Uint8Array>;
};

// dynamic Anchor import (works in RN)
let _anchorModPromise: Promise<any> | null = null;
async function loadAnchor() {
  if (!_anchorModPromise) _anchorModPromise = import('@coral-xyz/anchor');
  return _anchorModPromise;
}

// Project API config
const partnerCode = '<ORBITXPAY_PARTNER_CODE>';
const appCode = '<ORBITXPAY_APP_CODE>';
const appVersion = '2.8.0';
const authToken =
  '<ORBITXPAY_USER_AUTH_TOKEN>';

const projectWithdrawalUrl =
  'https://api-qa.orbitxpay.com/api/v1/wallet/withdrawal';
const projectDepositUrl = 'https://api-qa.orbitxpay.com/api/v1/wallet/deposit';
const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';

// ───────────── helpers for hashing (unchanged from your working code) ─────────
class HashUtils {
  static keccak256Hex(data: string): string {
    const wordArray = crypto.enc.Hex.parse(data);
    const hash = crypto.SHA3(wordArray, { outputLength: 256 });
    return hash.toString();
  }
  static keccak256(data: string): string {
    const hash = crypto.SHA3(data, { outputLength: 256 });
    return hash.toString();
  }
  static encodeString(v: string) {
    return HashUtils.keccak256(v);
  }
  static encodeAddress(v: PublicKey) {
    return v.toBuffer().toString('hex');
  }
  static encodeUInt32(v: bigint | number) {
    return v.toString(16).padStart(8, '0');
  }
  static encodeUInt64(v: bigint) {
    return v.toString(16).padStart(16, '0');
  }
  static encodeBytes(v: Uint8Array) {
    return Array.from(v)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
class PaddingBytesMessage {
  static encode() {
    return HashUtils.encodeBytes(
      new Uint8Array(Buffer.from('\x19\x01', 'latin1')),
    );
  }
}
class DomainSeparatorMessage {
  private static DOMAIN_TYPE_HASH = HashUtils.encodeString(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)',
  );
  static encode(
    name: string,
    version: string,
    chainId: bigint,
    verifying: PublicKey,
    salt: Uint8Array,
  ) {
    const encoded = [
      this.DOMAIN_TYPE_HASH,
      HashUtils.encodeString(name),
      HashUtils.encodeString(version),
      HashUtils.encodeUInt64(chainId),
      HashUtils.encodeAddress(verifying),
      HashUtils.encodeBytes(salt),
    ].join('');
    return HashUtils.keccak256Hex(encoded);
  }
}

type WithdrawCollateral = {
  amountOfAsset: BN;
  signatureExpirationTime: BN;
  coordinatorSignatureSalt: number[];
};

class Collateral {
  private static COLLATERAL_ADMIN_SIGNATURE_SEED = Buffer.from(
    'CollateralAdminSignatures',
    'utf-8',
  );
  private static WITHDRAW_TYPE_HASH = HashUtils.encodeString(
    'Withdraw(address user,address asset,uint256 amount,address recipient,uint256 nonce)',
  );

  static generateAdminSignaturePDA(
    collateral: PublicKey,
    id: Buffer,
    programId: PublicKey,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [this.COLLATERAL_ADMIN_SIGNATURE_SEED, collateral.toBuffer(), id],
      programId,
    );
    return pda;
  }

  static encodeWithdrawMessage(
    collateral: PublicKey,
    sender: PublicKey,
    receiver: PublicKey,
    asset: PublicKey,
    withdraw: WithdrawCollateral,
    adminFundsNonce: number,
  ) {
    const amount = BigInt(withdraw.amountOfAsset.toString());
    const enc = [
      this.WITHDRAW_TYPE_HASH,
      HashUtils.encodeAddress(sender),
      HashUtils.encodeAddress(collateral),
      HashUtils.encodeAddress(asset),
      HashUtils.encodeUInt64(amount),
      HashUtils.encodeAddress(receiver),
      HashUtils.encodeUInt32(adminFundsNonce),
    ].join('');
    return HashUtils.keccak256Hex(enc);
  }

  static generateWithdrawCollateralPDA(
    collateral: PublicKey,
    sender: PublicKey,
    receiver: PublicKey,
    asset: PublicKey,
    request: WithdrawCollateral,
    adminFundsNonce: number,
    programId: PublicKey,
  ): PublicKey {
    const enc = this.encodeWithdrawMessage(
      collateral,
      sender,
      receiver,
      asset,
      request,
      adminFundsNonce,
    );
    return this.generateAdminSignaturePDA(
      collateral,
      Buffer.from(enc, 'hex'),
      programId,
    );
  }

  static getWithdrawMessage(
    collateral: PublicKey,
    sender: PublicKey,
    receiver: PublicKey,
    asset: PublicKey,
    withdraw: WithdrawCollateral,
    salt: number[],
    adminFundsNonce: number,
  ): Buffer {
    const encoded = [
      PaddingBytesMessage.encode(),
      DomainSeparatorMessage.encode(
        'Collateral',
        '2',
        BigInt(900),
        collateral,
        new Uint8Array(salt),
      ),
      this.encodeWithdrawMessage(
        collateral,
        sender,
        receiver,
        asset,
        withdraw,
        adminFundsNonce,
      ),
    ].join('');
    return Buffer.from(HashUtils.keccak256Hex(encoded), 'hex');
  }
}

class Coordinator {
  private static WITHDRAW_TYPE_HASH = HashUtils.encodeString(
    'Withdraw(address user,address collateral,address asset,uint256 amount,address recipient,uint256 nonce,uint256 expiresAt)',
  );

  static encodeWithdrawMessage(
    collateral: PublicKey,
    sender: PublicKey,
    receiver: PublicKey,
    asset: PublicKey,
    withdraw: WithdrawCollateral,
    adminFundsNonce: number,
  ) {
    const amount = BigInt(withdraw.amountOfAsset.toString());
    const expiresAt = BigInt(withdraw.signatureExpirationTime.toString());
    const enc = [
      this.WITHDRAW_TYPE_HASH,
      HashUtils.encodeAddress(sender),
      HashUtils.encodeAddress(collateral),
      HashUtils.encodeAddress(asset),
      HashUtils.encodeUInt64(amount),
      HashUtils.encodeAddress(receiver),
      HashUtils.encodeUInt32(adminFundsNonce),
      HashUtils.encodeUInt64(expiresAt),
    ].join('');
    return HashUtils.keccak256Hex(enc);
  }

  static getWithdrawMessage(
    collateral: PublicKey,
    coordinator: PublicKey,
    sender: PublicKey,
    receiver: PublicKey,
    asset: PublicKey,
    withdraw: WithdrawCollateral,
    adminFundsNonce: number,
  ) {
    const encoded = [
      PaddingBytesMessage.encode(),
      DomainSeparatorMessage.encode(
        'Coordinator',
        '2',
        BigInt(900),
        coordinator,
        new Uint8Array(withdraw.coordinatorSignatureSalt),
      ),
      this.encodeWithdrawMessage(
        collateral,
        sender,
        receiver,
        asset,
        withdraw,
        adminFundsNonce,
      ),
    ].join('');
    return Buffer.from(HashUtils.keccak256Hex(encoded), 'hex');
  }
}

// utilities
function randomBytes(len = 32): Uint8Array {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}

async function makeProgram(
  connection: Connection,
  wallet: WalletAdapter,
  programAddress: string,
) {
  const anchor = await loadAnchor();
  const { AnchorProvider, Program } = anchor;
  const idl: any = Object.assign({}, mainIdl, { address: programAddress });
  const opts = AnchorProvider.defaultOptions?.() ?? {
    commitment: 'processed',
    preflightCommitment: 'processed',
  };
  const provider = new AnchorProvider(connection, wallet as any, opts);
  return new Program(idl, provider);
}

async function signAndSend(
  connection: Connection,
  wallet: WalletAdapter,
  tx: Transaction,
) {
  tx.feePayer = wallet.publicKey;
  if (!tx.recentBlockhash) {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
  }
  const signed = await wallet.signTransaction(tx);
  try {
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  } catch (e: any) {
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection);
      throw new Error(`Simulation failed:\n${(logs || []).join('\n')}`);
    }
    throw e;
  }
}

// submitCollateralSignature: Phantom signs the admin message bytes
async function submitCollateralSignature(
  wallet: WalletAdapter,
  recipientAddress: PublicKey,
  mintAddress: PublicKey,
  withdrawRequest: WithdrawCollateral,
  adminFundsNonce: number,
  program: any,
  collateralAddress: PublicKey,
) {
  if (!wallet.signMessage) throw new Error('Wallet missing signMessage');

  const collateralMessageSalt: number[] = Array.from(randomBytes(32)).map(
    Number,
  );
  const collateralMessage = Collateral.getWithdrawMessage(
    collateralAddress,
    wallet.publicKey,
    recipientAddress,
    mintAddress,
    withdrawRequest,
    collateralMessageSalt,
    adminFundsNonce,
  );

  // sign arbitrary bytes with Phantom
  const collateralSignature = await wallet.signMessage(collateralMessage);

  const collateralSignatureAddress = Collateral.generateWithdrawCollateralPDA(
    collateralAddress,
    wallet.publicKey,
    recipientAddress,
    mintAddress,
    withdrawRequest,
    adminFundsNonce,
    program.programId,
  );

  const existing =
    await program.account.collateralAdminSignatures.fetchNullable(
      collateralSignatureAddress,
    );

  if (
    !existing ||
    existing.signers.every((s: PublicKey) => !s.equals(wallet.publicKey))
  ) {
    const verifyIx = Ed25519Program.createInstructionWithPublicKey({
      message: collateralMessage,
      publicKey: wallet.publicKey.toBuffer(),
      signature: Buffer.from(collateralSignature),
    });

    const submitIx = await program.methods
      .submitSignatures({
        salts: [collateralMessageSalt],
        targetNonce: adminFundsNonce,
        signatureSubmissionType: {
          withdrawCollateralAsset: {
            sender: wallet.publicKey,
            receiver: recipientAddress,
            asset: mintAddress,
            withdrawRequest,
          },
        },
      })
      .accounts({
        collateral: collateralAddress,
        collateralAdminSignatures: collateralSignatureAddress,
        rentPayer: wallet.publicKey,
      })
      .instruction();

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))
      .add(verifyIx)
      .add(submitIx);

    await signAndSend(program.provider.connection, wallet, tx);
  }

  return collateralSignatureAddress;
}

// execute withdrawal
async function executeWithdrawal(
  program: any,
  collateral: PublicKey,
  depositAuthority: PublicKey,
  wallet: WalletAdapter,
  recipientAddress: PublicKey,
  mintAddress: PublicKey,
  expiration: number,
  amountInCents: number,
  signatureSalt: Buffer,
  signatureData: Buffer,
) {
  const withdrawRequest: WithdrawCollateral = {
    amountOfAsset: new BN(Number(amountInCents)),
    signatureExpirationTime: new BN(Number(expiration)),
    coordinatorSignatureSalt: Array.from(signatureSalt).map(Number),
  };

  const collateralAccount = await program.account.collateral.fetch(collateral);

  const collateralTokenAccount = await getAssociatedTokenAddress(
    mintAddress,
    depositAuthority,
    true,
  );

  const receiverATA = await getAssociatedTokenAddress(
    mintAddress,
    recipientAddress,
  );
  const ataInfo = await program.provider.connection.getAccountInfo(receiverATA);
  const maybeCreateATA = ataInfo
    ? null
    : createAssociatedTokenAccountInstruction(
        wallet.publicKey, // payer
        receiverATA,
        recipientAddress,
        mintAddress,
        TOKEN_PROGRAM_ID,
      );

  // ensure admin sig is stored
  const collateralSignatureAddress = await submitCollateralSignature(
    wallet,
    recipientAddress,
    mintAddress,
    withdrawRequest,
    collateralAccount.adminFundsNonce,
    program,
    collateral,
  );

  const verifyCoordinatorIx = Ed25519Program.createInstructionWithPublicKey({
    message: Coordinator.getWithdrawMessage(
      collateral,
      collateralAccount.coordinator,
      wallet.publicKey,
      recipientAddress,
      mintAddress,
      withdrawRequest,
      collateralAccount.adminFundsNonce,
    ),
    publicKey: new PublicKey(
      '8pyuGBnfbCADScManuTtA23mjXmJDbzpgPw2R8tmC6gz',
    ).toBuffer(),
    signature: Buffer.from(signatureData),
  });

  const withdrawIx = await program.methods
    .withdrawCollateralAsset(withdrawRequest)
    .accounts({
      sender: wallet.publicKey,
      receiver: recipientAddress,
      asset: mintAddress,
      collateralTokenAccount,
      receiverTokenAccount: receiverATA,
      coordinator: collateralAccount.coordinator,
      collateral,
      collateralAdminSignatures: collateralSignatureAddress,
    })
    .instruction();

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }))
    .add(verifyCoordinatorIx);

  if (maybeCreateATA) tx.add(maybeCreateATA);
  tx.add(withdrawIx);

  await signAndSend(program.provider.connection, wallet, tx);
}

// ───────────────────────────────────────────────────────────────────────────────
// Public entry: same as before, but now takes wallet & optional connection
// ───────────────────────────────────────────────────────────────────────────────
type FetchV2SignatureOpts = {
  token: string;
  amount: string | number;
  recipientAddress: string;
  chainId: string | number;
  wallet: WalletAdapter;
  connection?: Connection;
};

export const main = async ({
  token,
  amount,
  recipientAddress,
  chainId,
  wallet,
  connection: connOpt,
}: FetchV2SignatureOpts) => {
  try {
    if (!partnerCode || !appCode || !authToken) {
      throw new Error('Missing required project API credentials');
    }
    if (!wallet?.publicKey) throw new Error('Wallet not connected');

    const connection =
      connOpt ?? new Connection(DEFAULT_DEVNET_RPC, { commitment: 'confirmed' });

    // 1) Ask your API for the signature package
    const withdrawalBody = {
      chainId: typeof chainId === 'string' ? Number(chainId) : chainId,
      token,
      amount: typeof amount === 'string' ? Number(amount) : amount,
      recipientAddress,
    } as any;

    let signatureResponse: any;
    const { data } = await axios.post(projectWithdrawalUrl, withdrawalBody, {
      headers: {
        Accept: 'application/json',
        'x-partner-code': partnerCode,
        'x-app-code': appCode,
        'x-app-version': appVersion,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    });
    signatureResponse = data;

    if (!signatureResponse || !Array.isArray(signatureResponse.parameters)) {
      throw new Error('Invalid signature response received');
    }
    const status = String(signatureResponse.status ?? '').toLowerCase();
    if (status === 'pending' || status === 'processing') {
      throw new Error(`Signature is not ready: ${signatureResponse.status}`);
    }

    const collateralProxy = signatureResponse.parameters[0];
    const assetAddress = signatureResponse.parameters[1];
    const amountInCents = signatureResponse.parameters[2];
    const recipient = signatureResponse.parameters[3];
    const expiresAt = signatureResponse.parameters[4];

    let executorPublisherSalt: Buffer;
    if (signatureResponse?.signature?.salt) {
      executorPublisherSalt = Buffer.from(
        signatureResponse.signature.salt,
        'base64',
      );
    } else if (Array.isArray(signatureResponse.parameters[5])) {
      executorPublisherSalt = Buffer.from(signatureResponse.parameters[5]);
    } else if (typeof signatureResponse.parameters[5] === 'string') {
      executorPublisherSalt = Buffer.from(
        signatureResponse.parameters[5],
        'base64',
      );
    } else {
      throw new Error('Unable to parse coordinator signature salt');
    }

    let executorPublisherSig: Buffer;
    if (signatureResponse?.signature?.data) {
      const s: string = signatureResponse.signature.data;
      executorPublisherSig = s.startsWith('0x')
        ? Buffer.from(s.slice(2), 'hex')
        : Buffer.from(s, 'base64');
    } else if (signatureResponse.parameters[6]) {
      const s = signatureResponse.parameters[6];
      executorPublisherSig =
        typeof s === 'string' ? Buffer.from(s, 'base64') : Buffer.from(s);
    } else {
      throw new Error('Unable to parse coordinator signature data');
    }

    // 2) Deposit mapping
    const { data: depositPayload } = await axios.get(projectDepositUrl, {
      headers: {
        Accept: 'application/json',
        'x-partner-code': partnerCode,
        'x-app-code': appCode,
        'x-app-version': appVersion,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    });
    const selectedDeposit = depositPayload?.deposits?.find(
      (d: any) => d.proxyAddress === collateralProxy,
    );
    if (!selectedDeposit) throw new Error('Contract not found');

    const contract = {
      proxyAddress: selectedDeposit.proxyAddress,
      depositAddress:
        selectedDeposit.depositAddress || selectedDeposit.proxyAddress,
    } as any;

    // 3) Discover program and build Anchor Program instance using Phantom wallet
    const contractAccount = await connection.getAccountInfo(
      new PublicKey(collateralProxy),
    );
    if (!contractAccount)
      throw new Error(
        `Contract account ${collateralProxy} not found in Solana blockchain`,
      );
    const program = await makeProgram(
      connection,
      wallet,
      contractAccount.owner.toBase58(),
    );

    // 4) Execute withdrawal
    await executeWithdrawal(
      program,
      new PublicKey(collateralProxy),
      new PublicKey(contract.depositAddress),
      wallet,
      new PublicKey(recipient),
      new PublicKey(assetAddress),
      Number(expiresAt),
      Number(amountInCents),
      executorPublisherSalt,
      executorPublisherSig,
    );
  } catch (err: any) {
    const resp = (err as any)?.response;
    const detail =
      resp?.data?.message ||
      resp?.data?.error ||
      resp?.statusText ||
      (err?.message ?? String(err));
    throw new Error(`Withdrawal failed: ${detail}`);
  }
};
