export type WalletInput = {
  address: string; label?: string; pnl: number; volume: number; trades: number;
  resolvedTrades: number; wins: number; largestTradePnl: number;
  consistencyEvidence?: number;
  averageLiquidity: number; averageSpread: number; averagePriceMove: number;
  category: string;
};

export type WalletScore = {
  roi: number; consistency: number; copyability: number; oneHitPenalty: number;
  categoryEdge: number; global: number; status: "track" | "watch" | "ignore";
  reason: string;
};

export type TradeInput = {
  walletGlobal: number; walletCategory: number; walletEntry: number;
  currentPrice: number; spread: number; liquidity: number; hoursToResolution: number;
};

export type Rules = {
  minWalletScore: number; minTradeScore: number; maxSpread: number;
  minLiquidity: number; maxPriceMove: number; minResolvedTrades: number;
};
