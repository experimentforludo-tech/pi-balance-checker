// lib/derive.js
const bip39 = require('bip39');
const StellarBase = require('stellar-base');

function deriveAddressFromSeedPhrase(seedPhrase) {
  const mnemonic = seedPhrase.trim().toLowerCase();
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid seed phrase');
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const keypair = StellarBase.Keypair.fromRawEd25519Seed(seed.slice(0, 32));
  return keypair.publicKey();
}

module.exports = { deriveAddressFromSeedPhrase };