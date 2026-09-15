import type { Rules, TradeInput, WalletInput, WalletScore } from "./types.ts";

export const defaultRules: Rules = {
  minWalletScore: 58,
  minTradeScore: 65,
  maxSpread: 0.06,
  minLiquidity: 5_000,
  maxPriceMove: 0.08,
  minResolvedTrades: 8,
};

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

export function scoreWallet(w: WalletInput, rules = defaultRules): WalletScore {
  const roiRate = w.volume > 0 ? w.pnl / w.volume : 0;
  const roi = clamp(50 + roiRate * 250);
  const winRate = w.resolvedTrades ? w.wins / w.resolvedTrades : 0;
  const sample = clamp((w.resolvedTrades / Math.max(rules.minResolvedTrades, 1)) * 100);
  const consistency = w.consistencyEvidence === undefined ? clamp((winRate * 70) + (sample * 0.3)) : clamp(w.consistencyEvidence);
  const profitConcentration = w.pnl > 0 ? Math.max(0, w.largestTradePnl / w.pnl) : 1;
  const oneHitPenalty = clamp((profitConcentration - 0.35) * 120);
  const liquidity = clamp((w.averageLiquidity / rules.minLiquidity) * 70);
  const spread = clamp((1 - w.averageSpread / rules.maxSpread) * 100);
  const timing = clamp((1 - w.averagePriceMove / rules.maxPriceMove) * 100);
  const copyability = clamp(liquidity * 0.35 + spread * 0.35 + timing * 0.3);
  const categoryEdge = clamp(winRate * 100);
  const global = clamp(roi * 0.28 + consistency * 0.27 + copyability * 0.35 + categoryEdge * 0.1 - oneHitPenalty * 0.35);
  const status = global >= rules.minWalletScore ? "track" : global >= rules.minWalletScore - 15 ? "watch" : "ignore";
  const reason = status === "track" ? "Repeatable returns and entries that can realistically be copied"
    : status === "watch" ? "Promising, but needs more evidence or easier execution"
    : "Weak sample, concentrated profit, or difficult market conditions";
  return { roi, consistency, copyability, oneHitPenalty, categoryEdge, global, status, reason };
}

export function scoreTrade(t: TradeInput, rules = defaultRules) {
  const spreadScore = clamp((1 - t.spread / rules.maxSpread) * 100);
  const liquidityScore = clamp((t.liquidity / rules.minLiquidity) * 70);
  const timingScore = 100; // informational compatibility only; price movement is intentionally ignored
  const horizonScore = clamp(t.hoursToResolution / 72 * 100);
  const score = clamp(t.walletGlobal * 0.33 + t.walletCategory * 0.17 + spreadScore * 0.225 + liquidityScore * 0.225 + horizonScore * 0.05);
  const hardStop = t.spread > rules.maxSpread || t.liquidity < rules.minLiquidity;
  const decision = hardStop ? "skip" : score >= rules.minTradeScore ? "paper_copy" : score >= rules.minTradeScore - 12 ? "watchlist" : "skip";
  const size = decision === "paper_copy" ? Math.round((5 + clamp((score - rules.minTradeScore) / (100 - rules.minTradeScore)) * 15) * 100) / 100 : 0;
  const rejectionReasons:string[]=[];
  if(t.spread>rules.maxSpread)rejectionReasons.push(`spread ${(t.spread*100).toFixed(1)}¢ exceeded ${(rules.maxSpread*100).toFixed(1)}¢`);
  if(t.liquidity<rules.minLiquidity)rejectionReasons.push(`liquidity $${t.liquidity.toFixed(0)} was below $${rules.minLiquidity.toFixed(0)}`);
  if(!hardStop&&score<rules.minTradeScore)rejectionReasons.push(`trade score ${score.toFixed(1)} was below ${rules.minTradeScore}`);
  return { score, decision, size, spreadScore, liquidityScore, timingScore, rejectionReasons } as const;
}

export function paperPnl(side: "BUY" | "SELL", entry: number, current: number, dollars: number) {
  if (entry <= 0 || entry >= 1 || dollars < 0) throw new Error("Invalid paper position");
  const shares = dollars / entry;
  return Math.round((side === "BUY" ? current - entry : entry - current) * shares * 1_000_000) / 1_000_000;
}
