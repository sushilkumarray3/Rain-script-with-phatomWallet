import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Alert,
  TextInput,
  ScrollView,
  ActivityIndicator,
} from 'react-native';

import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';

// Removed SPL token/SOL transfer UI imports since we only keep Rain Withdrawal UI

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { main as rainWithdraw } from './withdrawal';

// ───────────────────────────────────────────────────────────────────────────────
// Exposed getter so other modules (withdrawal.ts) can obtain the Phantom signer
// ───────────────────────────────────────────────────────────────────────────────
export let getPhantomSigner: () => {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
  signMessage: (bytes: Uint8Array) => Promise<Uint8Array>;
} = () => {
  throw new Error('Phantom wallet not connected yet');
};

const App = () => {
  // dapp keypair for encryption with Phantom
  const [dappKeyPair] = useState(nacl.box.keyPair());

  // session & cryptography
  const [_sharedSecret, setSharedSecret] = useState<Uint8Array | null>(null);
  const sharedSecretRef = useRef<Uint8Array | null>(null);
  const [session, setSession] = useState<string | null>(null);

  // phantom state
  const [phantomWalletPublicKey, setPhantomWalletPublicKey] = useState<
    string | null
  >(null);
  const [, setDeepLink] = useState('');

  // resolver for a transaction we asked Phantom to sign
  const pendingTxResolverRef = useRef<((tx: Transaction) => void) | null>(null);
  // whether to broadcast from the app after signing
  const pendingSendRef = useRef<boolean>(true);

  // resolver for a raw message (bytes) we asked Phantom to sign
  const pendingMsgResolverRef = useRef<((sig: Uint8Array) => void) | null>(
    null,
  );

  // UI form state
  const [receiverAddress, setRecipientAddress] = useState(
    'BeJmtM2wd8td4Cyz9sWWN4dhZU1yMeJpAKgfBzD44gmE',
  );
  const [transferAmount, setTransferAmount] = useState('2');
  const [tokenMintAddress, setTokenMintAddress] = useState(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  );
  const [withdrawing, setWithdrawing] = useState(false);

  // Use DEVNET for everything (Rain expects devnet in this setup)
  const connection = useMemo(() => new Connection('https://api.devnet.solana.com'), []);

  // Deeplink plumbing moved below after handlers are defined

  const buildUrl = (path: string, params: Record<string, string>) => {
    const url = new URL(`https://phantom.app/ul/v1/${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    return url.toString();
  };

  const encryptPayload = (
    payload: Record<string, unknown>,
    secret: Uint8Array | null,
  ) => {
    if (!secret) throw new Error('Missing shared secret');
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.box.after(
      Buffer.from(JSON.stringify(payload)),
      nonce,
      secret,
    );
    return [nonce, encrypted] as const;
  };

  const decryptPayload = useCallback((
    data: string,
    nonce: string,
    secret: Uint8Array | null,
  ) => {
    if (!secret) throw new Error('Missing shared secret');
    const dec = nacl.box.open.after(
      bs58.decode(data),
      bs58.decode(nonce),
      secret,
    );
    return JSON.parse(Buffer.from(dec).toString());
  }, []);

  // ───────────────────────────────────────────────────────────────────────────
  // Connect / Disconnect
  // ───────────────────────────────────────────────────────────────────────────
  const connect = async () => {
    const params = {
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      cluster: 'devnet',
      app_url: 'https://yourapp.com',
      redirect_link: 'yourapp://onPhantomConnected',
    };
    Linking.openURL(buildUrl('connect', params));
  };

  const handleConnectResponse = useCallback((responseUrl: string) => {
    const url = new URL(responseUrl);
    const params = Object.fromEntries(url.searchParams.entries());
    if (params.errorCode) {
      Alert.alert('Connection Error', params.errorMessage);
      return;
    }
    const phantomPubEnc = bs58.decode(params.phantom_encryption_public_key);
    const shared = nacl.box.before(phantomPubEnc, dappKeyPair.secretKey);
    const data = decryptPayload(params.data, params.nonce, shared);

    setSharedSecret(shared);
    sharedSecretRef.current = shared;
    setSession(data.session);
    setPhantomWalletPublicKey(data.public_key);
    Alert.alert('Connected!', `Public Key: ${data.public_key}`);
  }, [dappKeyPair.secretKey, decryptPayload]);

  const disconnect = async () => {
    const [nonce, encryptedPayload] = encryptPayload(
      { session },
      sharedSecretRef.current,
    );
    const params = {
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      nonce: bs58.encode(nonce),
      redirect_link: 'yourapp://onPhantomDisconnected',
      payload: bs58.encode(encryptedPayload),
    };
    Linking.openURL(buildUrl('disconnect', params));
  };

  const handleDisconnectResponse = useCallback(() => {
    setSharedSecret(null);
    sharedSecretRef.current = null;
    setSession(null);
    setPhantomWalletPublicKey(null);
    Alert.alert('Disconnected', 'Successfully disconnected from Phantom');
  }, []);

  // ───────────────────────────────────────────────────────────────────────────
  // Generic signMessage(bytes) used by withdrawal.ts (returns signature bytes)
  // ───────────────────────────────────────────────────────────────────────────
  const signBytesWithPhantom = async (
    bytes: Uint8Array,
  ): Promise<Uint8Array> => {
    if (!session || !sharedSecretRef.current) {
      throw new Error('Wallet not connected');
    }
    const [nonce, encryptedPayload] = encryptPayload(
      {
        message: bs58.encode(bytes), // Phantom expects base58 string
        session,
        display: 'hex', // bytes are arbitrary; hex is fine
      },
      sharedSecretRef.current,
    );

    const params = {
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      nonce: bs58.encode(nonce),
      redirect_link: 'yourapp://onPhantomSigned',
      payload: bs58.encode(encryptedPayload),
    };

    // set resolver then open wallet
    const p = new Promise<Uint8Array>(resolve => {
      pendingMsgResolverRef.current = resolve;
    });
    Linking.openURL(buildUrl('signMessage', params));
    return p;
  };

  const handleSignResponse = useCallback((responseUrl: string) => {
    const url = new URL(responseUrl);
    const params = Object.fromEntries(url.searchParams.entries());
    if (params.errorCode) {
      Alert.alert('Signing Error', params.errorMessage);
      // reject if someone is awaiting
      if (pendingMsgResolverRef.current)
        pendingMsgResolverRef.current(new Uint8Array());
      pendingMsgResolverRef.current = null;
      return;
    }
    const dec = decryptPayload(
      params.data,
      params.nonce,
      sharedSecretRef.current,
    );
    // If an internal request is waiting, resolve with raw bytes
    if (pendingMsgResolverRef.current) {
      const sigBytes = bs58.decode(dec.signature);
      pendingMsgResolverRef.current(sigBytes);
      pendingMsgResolverRef.current = null;
      return;
    }
    // otherwise, show the default alert used by your "Sign Message" demo button
    Alert.alert('Message Signed!', `Signature: ${dec.signature}`);
  }, [decryptPayload]);

  // ───────────────────────────────────────────────────────────────────────────
  // Transaction signing: two modes
  //  - UI transfers: sign + send from the app (pendingSendRef = true)
  //  - Rain withdrawal: sign only (pendingSendRef = false) so withdrawal.ts sends
  // ───────────────────────────────────────────────────────────────────────────
  const signTransactionPhantom = async (
    transaction: Transaction,
    opts?: { send?: boolean },
  ) => {
    const send = opts?.send ?? true;

    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const [nonce, encryptedPayload] = encryptPayload(
      {
        transaction: bs58.encode(serialized),
        session,
      },
      sharedSecretRef.current,
    );

    const params = {
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      nonce: bs58.encode(nonce),
      redirect_link: 'yourapp://onPhantomTransactionSigned',
      payload: bs58.encode(encryptedPayload),
    };

    // Configure whether the handler should broadcast
    pendingSendRef.current = send;

    const p = new Promise<Transaction>(resolve => {
      pendingTxResolverRef.current = resolve;
    });

    Linking.openURL(buildUrl('signTransaction', params));
    return p;
  };

  const handleTransactionSignResponse = useCallback(async (responseUrl: string) => {
    const url = new URL(responseUrl);
    const params = Object.fromEntries(url.searchParams.entries());
    if (params.errorCode) {
      Alert.alert('Transaction Error', params.errorMessage);
      // still resolve pending with a dummy tx to unblock callers
      if (pendingTxResolverRef.current) {
        pendingTxResolverRef.current(new Transaction());
        pendingTxResolverRef.current = null;
      }
      return;
    }

    const dec = decryptPayload(
      params.data,
      params.nonce,
      sharedSecretRef.current,
    );
    const signedRaw = dec.transaction ?? dec.signed_transaction ?? '';
    const signedTxBytes = /^[1-9A-HJ-NP-Za-km-z]+$/.test(signedRaw)
      ? bs58.decode(signedRaw)
      : Buffer.from(signedRaw, 'base64');

    let signedTx: Transaction | null = null;
    try {
      signedTx = Transaction.from(signedTxBytes);
    } catch (e) {
      console.warn('Failed to decode signed transaction', e);
    }

    // Resolve any waiter (e.g., withdrawal.ts which will broadcast itself)
    if (pendingTxResolverRef.current && signedTx) {
      pendingTxResolverRef.current(signedTx);
      pendingTxResolverRef.current = null;
    }

    // For UI transfers we also broadcast from here
    if (pendingSendRef.current && signedTxBytes) {
      try {
        const signature = await connection.sendRawTransaction(signedTxBytes);
        await connection.confirmTransaction(signature, 'confirmed');
        Alert.alert('Transaction Sent!', `Signature: ${signature}`);
      } catch (err: any) {
        Alert.alert('Send Error', err?.message ?? String(err));
      }
    }
  }, [decryptPayload, connection]);

  // ───────────────────────────────────────────────────────────────────────────
  // Deeplink plumbing (after handlers are defined)
  // ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleDeepLink = ({ url }: { url: string }) => {
      setDeepLink(url);
      if (url.includes('onPhantomConnected')) {
        handleConnectResponse(url);
      } else if (url.includes('onPhantomDisconnected')) {
        handleDisconnectResponse();
      } else if (url.includes('onPhantomSigned')) {
        handleSignResponse(url);
      } else if (url.includes('onPhantomTransactionSigned')) {
        handleTransactionSignResponse(url);
      }
    };

    const linkingListener = Linking.addEventListener('url', handleDeepLink);
    return () => linkingListener?.remove();
  }, [handleConnectResponse, handleDisconnectResponse, handleSignResponse, handleTransactionSignResponse]);

  // Note: Removed standalone Sign Message demo button; signMessage is still used internally by withdrawal flow.

  // Removed SOL/Token transfer demo functions; focusing UI on Rain Withdrawal only

  // ───────────────────────────────────────────────────────────────────────────
  // Build the wallet adapter for withdrawal.ts (sign only; no send)
  // ───────────────────────────────────────────────────────────────────────────
  const buildSigner = () => {
    if (!phantomWalletPublicKey)
      throw new Error('Phantom wallet is not connected');
    return {
      publicKey: new PublicKey(phantomWalletPublicKey),
      signTransaction: async (tx: Transaction) =>
        signTransactionPhantom(tx, { send: false }),
      signAllTransactions: async (txs: Transaction[]) => {
        const out: Transaction[] = [];
        for (const t of txs)
          out.push(await signTransactionPhantom(t, { send: false }));
        return out;
      },
      signMessage: async (bytes: Uint8Array) => signBytesWithPhantom(bytes),
    };
  };

  // Keep exported getter up to date
  if (phantomWalletPublicKey) getPhantomSigner = buildSigner;

  // ───────────────────────────────────────────────────────────────────────────
  // Rain Withdrawal using Phantom signer
  // ───────────────────────────────────────────────────────────────────────────
  const doRainWithdrawal = async () => {
    try {
      setWithdrawing(true);
      const wallet = getPhantomSigner();
      if (!receiverAddress || !transferAmount || !tokenMintAddress) {
        Alert.alert('Error', 'Please fill in token, recipient and amount');
        return;
      }
      await rainWithdraw({
        token: tokenMintAddress,
        amount: transferAmount,
        recipientAddress: receiverAddress,
        chainId: '901', // devnet chain id as expected by backend
        wallet,
        connection, // reuse our devnet connection
      });
      Alert.alert('Withdrawal', 'Submitted!');
    } catch (e: any) {
      Alert.alert('Withdrawal Error', e?.message ?? String(e));
    } finally {
      setWithdrawing(false);
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────
  const connected = Boolean(phantomWalletPublicKey);

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Phantom Wallet DApp (devnet)</Text>

      {connected ? (
        <View style={styles.connectedContainer}>
          <Text style={styles.connectedText}>Connected!</Text>
          <Text style={styles.publicKey}>
            {phantomWalletPublicKey!.slice(0, 8)}...
            {phantomWalletPublicKey!.slice(-8)}
          </Text>

          <View style={styles.formContainer}>
            <Text style={styles.label}>Token Mint Address</Text>
            <TextInput
              style={styles.input}
              placeholder="Token Mint Address"
              value={tokenMintAddress}
              onChangeText={setTokenMintAddress}
              multiline
            />
            
            <Text style={styles.label}>Recipient Address</Text>
            <TextInput
              style={styles.input}
              placeholder="Recipient Address"
              value={receiverAddress}
              onChangeText={setRecipientAddress}
              multiline
            />
            
            <Text style={styles.label}>Amount</Text>
            <TextInput
              style={styles.input}
              placeholder="Amount"
              value={transferAmount}
              onChangeText={setTransferAmount}
              keyboardType="numeric"
            />
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={withdrawing ? undefined : doRainWithdrawal}
            disabled={withdrawing}
          >
            {withdrawing ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.buttonText}>Rain Withdrawal</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.disconnectButton]}
            onPress={disconnect}
          >
            <Text style={styles.buttonText}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.button} onPress={connect}>
          <Text style={styles.buttonText}>Connect Phantom</Text>
        </TouchableOpacity>
      )}

      {null}
    </ScrollView>
  );
};

// Styles
const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#f5f5f5' },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 24,
    color: '#333',
    textAlign: 'center',
    marginTop: 50,
  },
  connectedContainer: { alignItems: 'center' },
  connectedText: { fontSize: 18, color: 'green', marginBottom: 6 },
  publicKey: {
    fontSize: 14,
    color: '#666',
    marginBottom: 20,
    fontFamily: 'monospace',
  },
  transferTypeContainer: { flexDirection: 'row', marginBottom: 12 },
  typeButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 15,
    borderWidth: 1,
    borderColor: '#512da8',
    marginHorizontal: 5,
    borderRadius: 5,
  },
  activeTypeButton: { backgroundColor: '#512da8' },
  typeButtonText: { textAlign: 'center', color: '#512da8', fontWeight: 'bold' },
  activeTypeButtonText: { color: 'white' },
  formContainer: { width: '100%', marginBottom: 20 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    backgroundColor: 'white',
    fontSize: 16,
  },
  label: {
    fontSize: 13,
    color: '#666',
    marginBottom: 6,
    marginLeft: 2,
  },
  transferButton: {
    backgroundColor: '#4CAF50',
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: 8,
    marginVertical: 10,
    alignItems: 'center',
  },
  button: {
    backgroundColor: '#512da8',
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: 8,
    marginVertical: 10,
    minWidth: 200,
    alignItems: 'center',
  },
  disconnectButton: { backgroundColor: '#d32f2f' },
  buttonText: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  deepLink: { marginTop: 20, fontSize: 12, color: '#999', textAlign: 'center' },
});

export default App;
