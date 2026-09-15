export type Side = "BUY" | "SELL";
export type ActionKind = "entry" | "hedge" | "exit";
export type Intent = {
  id: number;
  idempotencyKey: string;
  tokenId: string;
  marketSlug: string;
  side: Side;
  actionKind: ActionKind;
  amount: number;
  priceLimit: number;
  signalCreatedAt: string;
  expiresAt: string;
};

export type Limits = {
  maxOrderUsd: number;
  maxTotalExposureUsd: number;
  maxDailyLossUsd: number;
  maxSignalAgeMs: number;
};

export function percentageOfCapital(capitalUsd:number,percent:number){
  if(!Number.isFinite(capitalUsd)||capitalUsd<0||!Number.isFinite(percent)||percent<0)throw new Error("invalid percentage budget inputs");
  return Math.floor(capitalUsd*percent)/100;
}

export function v61LiveEntryPercent(phase:string,paperSpent:number){
  if(phase==="deterministic_momentum")return 25;
  if(phase==="adaptive_value")return paperSpent>=30?17.5:10;
  return 0;
}

export function validateIntent(intent: Intent, limits: Limits, now = Date.now()) {
  if (!/^[0-9]+$/.test(intent.tokenId)) throw new Error("tokenId must be numeric");
  if (!intent.marketSlug || intent.marketSlug.length > 200) throw new Error("invalid market slug");
  if (intent.side !== "BUY" && intent.side !== "SELL") throw new Error("invalid side");
  if (!["entry","hedge","exit"].includes(intent.actionKind)) throw new Error("invalid action kind");
  if (intent.actionKind === "exit" && intent.side !== "SELL") throw new Error("exit intent must sell");
  if (intent.actionKind !== "exit" && intent.side !== "BUY") throw new Error("entry and hedge intents must buy");
  if (!Number.isFinite(intent.amount) || intent.amount <= 0) throw new Error("amount must be positive");
  if (!Number.isFinite(intent.priceLimit) || intent.priceLimit <= 0 || intent.priceLimit >= 1) throw new Error("price limit must be between 0 and 1");
  const signalAt = Date.parse(intent.signalCreatedAt), expiresAt = Date.parse(intent.expiresAt);
  if (!Number.isFinite(signalAt) || !Number.isFinite(expiresAt)) throw new Error("invalid timestamps");
  if (now - signalAt > limits.maxSignalAgeMs) throw new Error("stale signal");
  if (signalAt > now + 2_000) throw new Error("signal timestamp is in the future");
  if (expiresAt <= now) throw new Error("intent expired");
  if (intent.side === "BUY" && intent.amount > limits.maxOrderUsd) throw new Error("order exceeds maxOrderUsd");
}

export function assertRiskBudget(input: {intent: Intent; limits: Limits; openExposureUsd: number; dailyPnlUsd: number; collateralUsd: number}) {
  if (input.intent.side === "BUY") {
    if (input.dailyPnlUsd <= -input.limits.maxDailyLossUsd) throw new Error("daily loss stop reached");
    if (input.openExposureUsd + input.intent.amount > input.limits.maxTotalExposureUsd) throw new Error("exposure cap reached");
    if (input.collateralUsd < input.intent.amount) throw new Error("insufficient collateral");
  }
}

export function v61ActionKind(phase:string){
  if(phase==="adaptive_value"||phase==="deterministic_momentum")return {side:"BUY" as const,actionKind:"entry" as const};
  if(phase==="micro_hedge")return {side:"BUY" as const,actionKind:"hedge" as const};
  if(phase==="adaptive_exit")return {side:"SELL" as const,actionKind:"exit" as const};
  return null;
}

export function scaledLiveBuy(paperSpent:number,scale:number,minimumUsd:number){
  if(!Number.isFinite(paperSpent)||paperSpent<=0||!Number.isFinite(scale)||scale<=0||!Number.isFinite(minimumUsd)||minimumUsd<=0)throw new Error("invalid live sizing inputs");
  return Math.max(minimumUsd,paperSpent*scale);
}

export function executableSellShares(actionKind:ActionKind,requestedShares:number,walletShares:number){
  if(walletShares<=0)return 0;
  return actionKind==="exit"?walletShares:Math.min(requestedShares,walletShares);
}

export function assertActionDependency(actionKind:ActionKind,parentEntryStatus?:string){
  if(actionKind==="hedge"&&parentEntryStatus!=="accepted")throw new Error("parent live entry was not accepted; standalone hedge suppressed");
}

export function effectiveBuyAmount(targetUsd:number,minimumShares:number,priceLimit:number,maxOrderUsd:number,minimumMarketableUsd=1){
  const required=Math.ceil(Math.max(minimumMarketableUsd,minimumShares*priceLimit)*100)/100;
  const executable=Math.max(targetUsd,required);
  if(executable>maxOrderUsd)throw new Error(`minimum executable allocation $${executable.toFixed(2)} exceeds maxOrderUsd $${maxOrderUsd.toFixed(2)}`);
  return executable;
}

export function meetsMinimumShares(orderShares:number,minimumShares:number){
  // Decimal dollar and price arithmetic can turn an exact 5-share order into
  // 4.999999999999999 in binary floating point. Allow only machine-scale
  // rounding error; materially undersized orders remain rejected.
  return orderShares+1e-9>=minimumShares;
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/0x[a-fA-F0-9]{64}/g, "[redacted-secret]").slice(0, 500);
}
