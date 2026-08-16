// lib/piExplorer.js
//
// Pi Mainnet is a fork of Stellar and exposes a Horizon-compatible REST API.
// This module pulls together everything relevant for a wallet:
//
//   1. UNLOCKED (available) balance
//        GET /accounts/{address}
//        -> `balances[]` array. The entry with asset_type "native" is the
//           liquid/available Pi balance. Any other entries in that array
//           (asset_type "credit_alphanum4" / "credit_alphanum12") are OTHER
//           assets/tokens the wallet holds.
//
//   2. LOCKED balance + unlock date(s)
//        GET /claimable_balances?claimant={address}
//        -> Pi's mainnet lockup mechanism (like Stellar's) represents locked
//           tokens as "claimable balances" made out to the account, each with
//           a claim predicate that includes a `not: { abs_before }` timestamp
//           — that's the unlock date. A wallet can have several of these
//           (different lockup batches unlocking on different dates), so we
//           return the full breakdown plus a total and the *next* unlock date.
//
// NOTE: This relies on Pi's Horizon-compatible API exposing the standard
// Stellar `claimable_balances` endpoint the same way Stellar itself does.
// If your account's locked balance ever doesn't match what you see in
// https://blockexplorer.minepi.com, double check the raw response from
// PI_HORIZON_BASE_URL + /claimable_balances?claimant=<address> — Pi could
// diverge from stock Horizon behavior here.

const PI_HORIZON_BASE_URL =
  process.env.PI_HORIZON_BASE_URL || 'https://api.mainnet.minepi.com';

const FETCH_TIMEOUT_MS = 10_000;

function isPlausibleAddress(address) {
  return typeof address === 'string' && /^G[A-Z2-7]{55}$/.test(address.trim());
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
  } finally {
    clearTimeout(timer);
  }
}

function assetLabel(balanceEntry) {
  if (balanceEntry.asset_type === 'native') return 'PI';
  return balanceEntry.asset_code || balanceEntry.asset_type;
}

/**
 * Pull the unlocked native balance + every other asset from /accounts/{address}.
 */
async function fetchAccountBalances(address) {
  const { ok, status, data } = await fetchJson(`${PI_HORIZON_BASE_URL}/accounts/${address}`);

  if (status === 404) {
    return { found: false, unlockedBalance: 0, otherAssets: [] };
  }
  if (!ok) {
    throw new Error(`Explorer API returned HTTP ${status} for /accounts/${address}`);
  }

  const balances = data.balances || [];
  const nativeEntry = balances.find((b) => b.asset_type === 'native');
  const otherAssets = balances
    .filter((b) => b.asset_type !== 'native')
    .map((b) => ({
      asset: assetLabel(b),
      issuer: b.asset_issuer || null,
      balance: parseFloat(b.balance),
    }));

  return {
    found: true,
    unlockedBalance: nativeEntry ? parseFloat(nativeEntry.balance) : 0,
    otherAssets,
  };
}

/**
 * Extract the unlock ("not before") timestamp from a claimable balance's
 * claimant predicate, if one is present. Returns an ISO string or null
 * (null = unconditional / already claimable / unrecognized predicate shape).
 */
function extractUnlockDate(claimableBalanceRecord, address) {
  const claimant = (claimableBalanceRecord.claimants || []).find((c) => c.destination === address);
  if (!claimant) return null;

  function findAbsBefore(predicate) {
    if (!predicate) return null;
    if (predicate.not && predicate.not.abs_before) return predicate.not.abs_before;
    if (predicate.and) {
      for (const p of predicate.and) {
        const found = findAbsBefore(p);
        if (found) return found;
      }
    }
    if (predicate.or) {
      for (const p of predicate.or) {
        const found = findAbsBefore(p);
        if (found) return found;
      }
    }
    return null;
  }

  return findAbsBefore(claimant.predicate);
}

/**
 * Pull all locked-Pi claimable balances made out to this address.
 * Paginates through /claimable_balances?claimant=... in case a wallet has
 * many lockup batches.
 */
async function fetchLockedBalances(address) {
  const records = [];
  let url = `${PI_HORIZON_BASE_URL}/claimable_balances?claimant=${address}&limit=200`;
  let guard = 0;

  while (url && guard < 20) {
    guard += 1;
    const { ok, status, data } = await fetchJson(url);
    if (!ok) {
      if (status === 404) break;
      throw new Error(`Explorer API returned HTTP ${status} for /claimable_balances`);
    }

    const embedded = (data._embedded && data._embedded.records) || [];
    records.push(...embedded);

    const nextHref = data._links && data._links.next && data._links.next.href;
    url = nextHref && embedded.length > 0 ? nextHref : null;
  }

  const lockedBreakdown = records
    .filter((r) => !r.asset || r.asset === 'native')
    .map((r) => ({
      balanceId: r.id,
      amount: parseFloat(r.amount),
      unlockDate: extractUnlockDate(r, address),
    }));

  const lockedBalance = lockedBreakdown.reduce((sum, r) => sum + r.amount, 0);

  const futureUnlocks = lockedBreakdown
    .map((r) => r.unlockDate)
    .filter(Boolean)
    .sort();
  const nextUnlockDate = futureUnlocks.length > 0 ? futureUnlocks[0] : null;

  return { lockedBalance, nextUnlockDate, lockedBreakdown };
}

/**
 * Full lookup for a single address: unlocked balance, locked balance +
 * unlock date(s), and every other asset the wallet holds.
 * Always resolves (never throws) so one bad address doesn't break a batch.
 */
async function getAccountDetails(address) {
  const trimmed = (address || '').trim();

  if (!isPlausibleAddress(trimmed)) {
    return {
      address: trimmed,
      status: 'invalid',
      unlockedBalance: null,
      lockedBalance: null,
      nextUnlockDate: null,
      lockedBreakdown: [],
      otherAssets: [],
      error: 'Malformed Pi address',
    };
  }

  try {
    const accountInfo = await fetchAccountBalances(trimmed);

    if (!accountInfo.found) {
      return {
        address: trimmed,
        status: 'not_found',
        unlockedBalance: 0,
        lockedBalance: 0,
        nextUnlockDate: null,
        lockedBreakdown: [],
        otherAssets: [],
        error: null,
      };
    }

    const lockedInfo = await fetchLockedBalances(trimmed);

    return {
      address: trimmed,
      status: 'ok',
      unlockedBalance: accountInfo.unlockedBalance,
      lockedBalance: lockedInfo.lockedBalance,
      nextUnlockDate: lockedInfo.nextUnlockDate,
      lockedBreakdown: lockedInfo.lockedBreakdown,
      otherAssets: accountInfo.otherAssets,
      error: null,
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    return {
      address: trimmed,
      status: 'error',
      unlockedBalance: null,
      lockedBalance: null,
      nextUnlockDate: null,
      lockedBreakdown: [],
      otherAssets: [],
      error: message,
    };
  }
}

/**
 * Look up full details for a list of addresses with limited concurrency.
 */
async function getAccountsDetails(addresses, concurrency = 5) {
  const queue = [...addresses];
  const results = [];

  async function worker() {
    while (queue.length > 0) {
      const address = queue.shift();
      results.push(await getAccountDetails(address));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, addresses.length) }, worker);
  await Promise.all(workers);

  const order = new Map(addresses.map((a, i) => [a.trim(), i]));
  results.sort((a, b) => order.get(a.address) - order.get(b.address));

  return results;
}

module.exports = { getAccountDetails, getAccountsDetails, isPlausibleAddress };
