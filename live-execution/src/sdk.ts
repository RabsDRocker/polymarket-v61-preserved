import {createPublicClient, createSecureClient, OrderSide, OrderType} from "@polymarket/client";
import {privateKey} from "@polymarket/client/viem";
import {fetchBalanceAllowance} from "@polymarket/client/actions";
import {AssetType} from "@polymarket/bindings/clob";
import type {Intent} from "./core.ts";

export function portfolioTotals(positions:Iterable<any>){
  let openExposureUsd=0,currentValueUsd=0;
  for(const position of positions){
    const value=Math.max(0,Number(position.currentValue||0));
    // Settled positions no longer consume risk exposure, but winning shares
    // remain account value until redemption credits them back to collateral.
    if(position.redeemable!==true)openExposureUsd+=Math.max(0,Number(position.initialValue||0));
    currentValueUsd+=value;
  }
  return {openExposureUsd,currentValueUsd};
}

export async function createExchange() {
  const key=process.env.POLYMARKET_PRIVATE_KEY, wallet=process.env.POLYMARKET_WALLET_ADDRESS;
  if (!key || !wallet) throw new Error("wallet credentials are not configured");
  const apiKey=process.env.POLYMARKET_API_KEY,apiSecret=process.env.POLYMARKET_API_SECRET,apiPassphrase=process.env.POLYMARKET_API_PASSPHRASE;
  const supplied=[apiKey,apiSecret,apiPassphrase].filter(Boolean).length;
  if(supplied!==0&&supplied!==3)throw new Error("provide all three API credential fields or none");
  const credentials=supplied===3?{key:apiKey!,secret:apiSecret!,passphrase:apiPassphrase!}:undefined;
  const client=await createSecureClient({wallet,signer:privateKey(key),...(credentials?{credentials}:{})});
  return {
    async geoblock() {
      const response=await fetch("https://polymarket.com/api/geoblock",{signal:AbortSignal.timeout(5_000)});
      if (!response.ok) throw new Error(`geoblock check HTTP ${response.status}`);
      return await response.json() as {blocked:boolean;country:string;region:string};
    },
    async collateralUsd() {
      const value=await fetchBalanceAllowance(client,{assetType:AssetType.COLLATERAL});
      return Number(value.balance)/1_000_000;
    },
    async tokenShares(tokenId:string) {
      const value=await fetchBalanceAllowance(client,{assetType:AssetType.CONDITIONAL,assetId:tokenId});
      return Number(value.balance)/1_000_000;
    },
    async market(intent:Intent) {
      const market=await client.fetchMarket({slug:intent.marketSlug});
      const outcome=Object.values(market.outcomes).find((x:any)=>x?.tokenId===intent.tokenId) as any;
      if (!outcome) throw new Error("token does not belong to market slug");
      if (market.state.acceptingOrders === false || market.state.enableOrderBook !== true) throw new Error("market is not accepting order-book orders");
      return {minimumOrderSize:Number(market.trading.minimumOrderSize||0),minimumTickSize:Number(market.trading.minimumTickSize||0)};
    },
    async openOrders() {
      const rows:any[]=[]; for await (const page of client.listOpenOrders()) rows.push(...page.items); return rows;
    },
    async openExposureUsd() {
      return (await this.portfolio()).openExposureUsd;
    },
    async portfolio() {
      const positions:any[]=[];
      for await (const page of client.listPositions({pageSize:100})) positions.push(...page.items);
      return portfolioTotals(positions);
    },
    async place(intent:Intent) {
      if (intent.side==="BUY") return await client.placeMarketOrder({tokenId:intent.tokenId,side:OrderSide.BUY,amount:intent.amount,maxSpend:intent.amount,maxPrice:intent.priceLimit,orderType:OrderType.FAK});
      return await client.placeMarketOrder({tokenId:intent.tokenId,side:OrderSide.SELL,shares:intent.amount,minPrice:intent.priceLimit,orderType:OrderType.FAK});
    },
    async cancelAll() { return await client.cancelAll(); },
    close() { return client.closeSubscriptions(); }
  };
}

export function publicPreflight() {
  createPublicClient();
  return fetch("https://polymarket.com/api/geoblock",{signal:AbortSignal.timeout(5_000)}).then(async response=>{
    if (!response.ok) throw new Error(`geoblock check HTTP ${response.status}`);
    return response.json() as Promise<{blocked:boolean;country:string;region:string}>;
  });
}
