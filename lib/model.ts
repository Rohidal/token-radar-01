// Launch Radar model: sector comparables, damped momentum, and a track record.
//
// The snapshot never states what a protocol's token would be worth, so the model derives one from
// figures it does carry. Three ideas, in order of weight:
//
//   1. What the market already pays for this kind of protocol. Every token-bearing protocol in the
//      snapshot gives a comparable: its market cap over its TVL. A category's median ratio is what
//      the market has been willing to pay for that business model, and a pre-token protocol in that
//      category is marked at that multiple. Thin categories lean on the whole snapshot's median.
//   2. Momentum, damped. Seven-day TVL growth says capital is arriving or leaving now, but a week is
//      noisy and one 80% move is not a valuation, so the model trusts a fraction of it.
//   3. The track record it has run up without a token. A protocol that has held TVL for years under a
//      public, un-tokenised record has both more to hand a holder and more reason to launch; a
//      protocol listed last month has not shown that it lasts. The factor is bounded, never decisive.
//
//   multiple  = shrink(category median, global median)      clamped to MULTIPLE_FLOOR..MULTIPLE_CAP
//   growth    = clamp(change_7d, -60, 120) percent, damped by GROWTH_WEIGHT
//   record    = RECORD_FLOOR + min(age_days, RECORD_DAYS) / RECORD_DAYS * RECORD_SPAN
//   implied   = round(tvl_usd * multiple * growth * record), at least $1
//
// No protocol name is special-cased anywhere in this file: one function scores every row, and the
// dashboard prints the three multipliers it used for each one.

/** One protocol as the sealed snapshot writes it: exactly ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants: printed on the dashboard, never hidden. */
export interface ModelConstants {
  version: string;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  record_floor: number;
  record_span: number;
  record_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  sector_weight: number;
  min_sector_sample: number;
}

export const MODEL: ModelConstants = {
  version: 'radar-3-comps',
  growth_weight: 0.35,
  growth_floor: -60,
  growth_cap: 120,
  record_floor: 0.75,
  record_span: 0.45,
  record_days: 1460,
  unknown_age_days: 365,
  multiple_floor: 0.04,
  multiple_cap: 2.5,
  sector_weight: 0.65,
  min_sector_sample: 4,
};

/** Early rows: pre-token protocols under the watchlist floor, taken by TVL. */
export const EARLY_ROWS = 160;

/** Live rows: token-bearing protocols the page shows beside the board, by market cap. */
export const LIVE_ROWS = 20;

const DAY_MS = 86_400_000;
const MAX_IMPLIED = 100_000_000_000_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `from` to `to`, clamped at zero; null when either date is missing or unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers; NaN for an empty one. */
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version marker: a name that ends in a release is another protocol's pool. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Exchanges and their staking arms: a token's absence there says nothing about a launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Categories that are a product of another token rather than a protocol of their own. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A wrapped, staked or bridged product, by name. */
const PRODUCT_NAME = /\b(wrapped|staked|staking)\b/i;

/** Whether the board may rank a protocol: no token, no exchange, no versioned pool, no wrapper. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || PRODUCT_NAME.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** One comparable: a token-bearing protocol and the multiple the market pays for its TVL. */
export interface Comparable {
  slug: string;
  category: string | null;
  multiple: number;
}

/** The multiples the snapshot's own token-bearing protocols trade at, by category and overall. */
export interface Comps {
  global: number;
  global_sample: number;
  sectors: Map<string, { multiple: number; sample: number }>;
  comparables: Comparable[];
}

/**
 * The comparables the model learns from: every protocol that records both a market cap and a TVL
 * above the floor, with the ratio between them. Ratios are capped so a single mispriced listing
 * cannot set a category's multiple, and a category needs `min_sector_sample` of them to be used.
 */
export function buildComps(snapshot: Snapshot, model: ModelConstants = MODEL): Comps {
  const comparables: Comparable[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0) continue;
    if (p.tvl_usd < 5_000_000) continue;
    const raw = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(raw) || raw <= 0) continue;
    comparables.push({ slug: p.slug, category: p.category, multiple: Math.min(raw, 20) });
  }
  const global = comparables.length > 0 ? median(comparables.map((c) => c.multiple)) : 0.2;
  const byCategory = new Map<string, number[]>();
  for (const c of comparables) {
    if (c.category === null) continue;
    const list = byCategory.get(c.category);
    if (list === undefined) byCategory.set(c.category, [c.multiple]);
    else list.push(c.multiple);
  }
  const sectors = new Map<string, { multiple: number; sample: number }>();
  for (const [category, values] of byCategory) {
    if (values.length < model.min_sector_sample) continue;
    sectors.set(category, { multiple: median(values), sample: values.length });
  }
  return { global, global_sample: comparables.length, sectors, comparables };
}

/** Why the model refused a protocol, or the three multipliers it used. */
export interface Scored {
  implied: number;
  multiple: number;
  sector_multiple: number | null;
  sector_sample: number;
  used_global: boolean;
  growth_pct: number;
  growth_multiplier: number;
  record_multiplier: number;
  age_days: number | null;
}

/**
 * The implied value of one pre-token protocol: TVL times the multiple its category trades at, times
 * the damped growth factor, times its track-record factor. Every input is a snapshot field or a
 * constant above.
 */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, comps: Comps, model: ModelConstants = MODEL): Scored {
  const sector = p.category === null ? undefined : comps.sectors.get(p.category);
  const sectorMultiple = sector === undefined ? null : sector.multiple;
  const sectorSample = sector === undefined ? 0 : sector.sample;
  const blended = sectorMultiple === null ? comps.global : model.sector_weight * sectorMultiple + (1 - model.sector_weight) * comps.global;
  const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, blended));

  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMultiplier = 1 + (growthPct / 100) * model.growth_weight;

  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age === null ? model.unknown_age_days : age;
  const recordMultiplier = model.record_floor + (Math.min(Math.max(ageForModel, 0), model.record_days) / model.record_days) * model.record_span;

  const implied = Math.min(MAX_IMPLIED, Math.max(1, Math.round(p.tvl_usd * multiple * growthMultiplier * recordMultiplier)));
  return {
    implied,
    multiple: round4(multiple),
    sector_multiple: sectorMultiple === null ? null : round4(sectorMultiple),
    sector_sample: sectorSample,
    used_global: sectorMultiple === null,
    growth_pct: round4(growthPct),
    growth_multiplier: round4(growthMultiplier),
    record_multiplier: round4(recordMultiplier),
    age_days: age,
  };
}

/** One farm step: the action, then what it costs and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A board row: what board.json carries. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_status: 'pre-token';
  watchlist: boolean;
  model: {
    multiple: number;
    sector_multiple: number | null;
    used_global: boolean;
    growth_pct: number;
    growth_multiplier: number;
    record_multiplier: number;
  };
  farm_steps: string[];
}

/** A live-token protocol, shown with the market's own figure rather than the model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  symbol: string | null;
  change_7d: number | null;
}

/** The page's dataset, written as data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  comps: { global: number; global_sample: number; sectors: { category: string; multiple: number; sample: number }[] };
  totals: { tvl_usd: number; implied_usd: number; growth_up: number; growth_down: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** One row as the page reads it: the board row plus the plan it prints. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  watchlist: boolean;
  multiple: number;
  sector_multiple: number | null;
  used_global: boolean;
  growth_pct: number;
  growth_multiplier: number;
  record_multiplier: number;
  farm_steps: string[];
}

/** The capital a position needs, from the protocol's own TVL: deep pools take less slippage. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 25_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: a young protocol needs a longer record to count. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}

/** The chain a reader should act on: the one the protocol reports first. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The one action the protocol's category asks for, in a farmer's words. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and leave it there while the vault's allocation earns.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('basis')) return `Supply $${capital} of USDC to ${name} on ${chain}, borrow a small amount against it, and repay it twice.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and rebalance it once a month.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds inside its own app.`;
  if (c.includes('restak') || c.includes('staking') || c.includes('liquid')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and keep one small hedge open for a week.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one position in a market you already follow.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield asset on ${chain} and hold it through one distribution.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('chain') || c.includes('layer')) return `Bridge $${capital} of USDC onto ${name} and make three transactions in its own apps.`;
  if (c.includes('payment')) return `Send $${capital} of USDC through ${name} on ${chain} and keep the receipt of the route.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open across two weeks.`;
}

/**
 * The farm plan for one protocol: six steps, each with what it costs and how long it takes. Every
 * step follows from the protocol's own record (category, chains, TVL, age), never from a list of
 * names, and each lands inside the gate's 20..600 characters.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const share = p.tvl_usd >= 1_000_000_000 ? 'a top-5 TVL position' : p.tvl_usd >= 100_000_000 ? 'a top-20 TVL position' : 'a thin pool';
  return [
    {
      text: `Read ${p.name}'s own docs for a points, season or rewards page before you sign anything, and skip the protocol if the only claim path is a link in someone else's post.`,
      cost: 'nothing',
      time: '20 minutes',
    },
    {
      text: `Open a fresh wallet that holds only this farm's funds on ${chain} and fund it with $${capital} of USDC plus gas.`,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} stays at work, plus about $${gas} of gas to open it`,
      time: '20 minutes',
    },
    {
      text: `Repeat one qualifying action each week on ${p.name}: a deposit, a borrow and repay, a swap or a vote. ${share.charAt(0).toUpperCase()}${share.slice(1)} with $${p.tvl_usd.toLocaleString('en-US')} of TVL means your size moves nothing.`,
      cost: `about $${Math.max(2, Math.round(gas / 4))} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one snapshot, and do not move the wallet's funds to another address mid-farm.`,
      cost: `the $${capital} stays locked`,
      time: `${hold} days`,
    },
    {
      text: `Track it in a log with the wallet, each date, each transaction hash and what it cost, then check ${p.name}'s official page for a claim window before you unwind.`,
      cost: 'nothing but the log',
      time: '10 minutes a week',
    },
  ];
}

/** A step as one string: its action, then its cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/** The protocols the board ranks, strongest first with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = buildComps(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p] as const));
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, comps, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.age_days,
    implied_value_usd: s.implied,
    token_status: 'pre-token',
    watchlist: watchlist.has(p.slug),
    model: {
      multiple: s.multiple,
      sector_multiple: s.sector_multiple,
      used_global: s.used_global,
      growth_pct: s.growth_pct,
      growth_multiplier: s.growth_multiplier,
      record_multiplier: s.record_multiplier,
    },
    farm_steps: farmSteps(p, s.age_days).map(stepText),
  }));
}

/** The token-bearing protocols, by market cap, for the page's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      symbol: p.symbol,
      change_7d: p.change_7d,
    }));
}

/** Everything the page renders and the board carries, from one snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const comps = buildComps(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const sectors = [...comps.sectors.entries()]
    .map(([category, s]) => ({ category, multiple: round4(s.multiple), sample: s.sample }))
    .sort((a, b) => b.sample - a.sample || b.multiple - a.multiple)
    .slice(0, 10);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    comps: { global: round4(comps.global), global_sample: comps.global_sample, sectors },
    totals: {
      tvl_usd: board.reduce((n, r) => n + r.tvl_usd, 0),
      implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
      growth_up: board.filter((r) => (r.change_7d ?? 0) > 0).length,
      growth_down: board.filter((r) => (r.change_7d ?? 0) < 0).length,
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      watchlist: r.watchlist,
      multiple: r.model.multiple,
      sector_multiple: r.model.sector_multiple,
      used_global: r.model.used_global,
      growth_pct: r.model.growth_pct,
      growth_multiplier: r.model.growth_multiplier,
      record_multiplier: r.model.record_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model scores. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model expects. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate takes, or null: coverage, ranks, order, farm steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board carries ${board.length} rows, under the 100 the gate asks for`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** The page's whole dataset as one script: no fetch, no network, one global. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
