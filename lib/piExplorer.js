// lib/piExplorer.js
//
// Pi Network's Mainnet blockchain is a fork of Stellar and exposes a
// Horizon-compatible REST API. The public Block Explorer (blockexplorer.minepi.com)
// reads from this same API. We hit the accounts endpoint directly:
//
//   GET https://api.mainnet.minepi.com/accounts/{address}
//
// A successful response contains a `balances` array; the entry with
// asset_type "native" is the account's Pi balance.
//
// If you'd rather point at Testnet, swap PI_HORIZON_BASE_URL accordingly
// (e.g. https://api.testnet.minepi.com).

const PI_HORIZON_BASE_URL =
  process.env.PI_HORIZON_BASE_URL || 'https://api.mainnet.minepi.com';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Basic sanity check for a Pi/Stellar-style public key: starts with "G",
 * base32 charset, 56 characters total. This does NOT verify the checksum,
 * just filters out obviously malformed input before hitting the API.
 */
function isPlausibleAddress(address) {
  return typeof address === 'string' && /^G[A-Z2-7]{55}$/.test(address.trim());
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up the Pi balance for a single address.
 * Always resolves (never throws) with a result object, so that one bad
 * address doesn't blow up a batch lookup.
 */
async function getBalance(address) {
  const trimmed = (address || '').trim();

  if (!isPlausibleAddress(trimmed)) {
    return { address: trimmed, status: 'invalid', balance: null, error: 'Malformed Pi address' };
  }

  const url = `${PI_HORIZON_BASE_URL}/accounts/${trimmed}`;

  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);

    if (res.status === 404) {
      // Address is well-formed but has never been funded/activated on-chain.
      return { address: trimmed, status: 'not_found', balance: 0, error: null };
    }

    if (!res.ok) {
      return {
        address: trimmed,
        status: 'error',
        balance: null,
        error: `Explorer API returned HTTP ${res.status}`,
      };
    }

    const data = await res.json();
    const nativeBalance = (data.balances || []).find((b) => b.asset_type === 'native');

    return {
      address: trimmed,
      status: 'ok',
      balance: nativeBalance ? parseFloat(nativeBalance.balance) : 0,
      error: null,
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    return { address: trimmed, status: 'error', balance: null, error: message };
  }
}

/**
 * Look up balances for a list of addresses with limited concurrency, so a
 * large batch doesn't hammer the explorer API all at once.
 */
async function getBalances(addresses, concurrency = 5) {
  const queue = [...addresses];
  const results = [];

  async function worker() {
    while (queue.length > 0) {
      const address = queue.shift();
      results.push(await getBalance(address));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, addresses.length) }, worker);
  await Promise.all(workers);

  // Preserve the original input order in the output.
  const order = new Map(addresses.map((a, i) => [a.trim(), i]));
  results.sort((a, b) => order.get(a.address) - order.get(b.address));

  return results;
}

module.exports = { getBalance, getBalances, isPlausibleAddress };
