import priceData from './pricing-data.json';

export type PricingTier = 'free' | 'paid';

export interface ModelPrice {
  tier: PricingTier;
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface ReportedUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Token counts inferred by the gateway rather than reported by the provider. */
  estimated?: boolean;
}

export const PRICING_SCHEMA_VERSION = priceData.schemaVersion;
export const PRICING_EFFECTIVE_DATE = priceData.effectiveDate;

export const PRICES: PriceTable = Object.create(null);
for (const [modelId, price] of Object.entries(priceData.models)) {
  PRICES[modelId] = price as ModelPrice;
}

export function priceForModel(modelId: string, prices: PriceTable = PRICES): ModelPrice | undefined {
  return prices[modelId];
}

/** Cost in USD from reported tokens only. No price, free tier or estimated
 *  usage yields null — never a guessed number. */
export function costUsd(
  modelId: string,
  usage: { promptTokens: number; completionTokens: number; estimated?: boolean },
  prices: PriceTable = PRICES
): number | null {
  if (usage.estimated) return null;
  const price = priceForModel(modelId, prices);
  if (!price || price.tier !== 'paid') return null;
  const total = usage.promptTokens * price.promptUsdPerToken
    + usage.completionTokens * price.completionUsdPerToken;
  return Number(total.toFixed(6));
}

/** Aggregate cost across ledger events, skipping estimated and unpriced rows. */
export function costUsdForEvents(events: ReportedUsage[], prices: PriceTable = PRICES): number | null {
  let total = 0;
  let priced = false;
  for (const event of events) {
    const cost = costUsd(event.model, event, prices);
    if (cost === null) continue;
    total += cost;
    priced = true;
  }
  return priced ? Number(total.toFixed(6)) : null;
}

/** Routing may consider cost only for paid tiers; free/unknown models return null. */
export function routingCost(modelId: string, prices: PriceTable = PRICES): number | null {
  const price = priceForModel(modelId, prices);
  if (!price || price.tier !== 'paid') return null;
  return Number((price.promptUsdPerToken + price.completionUsdPerToken).toFixed(8));
}

/**
 * Order routing candidates by cost only when every candidate has a known paid
 * price. A free tier or unknown price anywhere leaves the original order intact.
 */
export function rankRoutingCandidates<T extends { modelId: string }>(
  candidates: T[],
  prices: PriceTable = PRICES
): T[] {
  if (candidates.length === 0) return candidates;
  const costs = candidates.map((candidate) => routingCost(candidate.modelId, prices));
  if (costs.some((cost) => cost === null)) return candidates;
  return candidates
    .map((candidate, index) => ({ candidate, cost: costs[index]! }))
    .sort((a, b) => a.cost - b.cost)
    .map((entry) => entry.candidate);
}
