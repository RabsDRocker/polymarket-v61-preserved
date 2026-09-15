import { cryptoTakerFee } from "./execution.ts";

type Level={price:string;size:string};
type Book={bids:Level[];asks:Level[]};

export const completeSetPolicy={
  minNetEdgePerPair:.015,
  executionBufferPerPair:.005,
  minLockedProfit:.25,
  maxDollarsPerMarket:100,
} as const;
type CompleteSetPolicy={minNetEdgePerPair:number;executionBufferPerPair:number;minLockedProfit:number;maxDollarsPerMarket:number};

export function simulateCompleteSet(upBook:Book,downBook:Book,maxSpend:number,policy:CompleteSetPolicy=completeSetPolicy){
  const up=[...upBook.asks].map(x=>({price:Number(x.price),size:Number(x.size)})).filter(x=>x.price>0&&x.price<1&&x.size>0).sort((a,b)=>a.price-b.price);
  const down=[...downBook.asks].map(x=>({price:Number(x.price),size:Number(x.size)})).filter(x=>x.price>0&&x.price<1&&x.size>0).sort((a,b)=>a.price-b.price);
  let ui=0,di=0,upRemaining=up[0]?.size||0,downRemaining=down[0]?.size||0,pairs=0,gross=0,fees=0,buffer=0,upGross=0,downGross=0,upFees=0,downFees=0;
  while(ui<up.length&&di<down.length&&maxSpend-gross-fees-buffer>1e-9){
    const upPrice=up[ui].price,downPrice=down[di].price;
    const feePerPair=.07*upPrice*(1-upPrice)+.07*downPrice*(1-downPrice);
    const bufferedUnitCost=upPrice+downPrice+feePerPair+policy.executionBufferPerPair;
    if(1-bufferedUnitCost<policy.minNetEdgePerPair)break;
    const take=Math.min(upRemaining,downRemaining,(maxSpend-gross-fees-buffer)/bufferedUnitCost);
    if(take<=1e-9)break;
    const upFee=cryptoTakerFee(take,upPrice),downFee=cryptoTakerFee(take,downPrice);
    pairs+=take;upGross+=take*upPrice;downGross+=take*downPrice;upFees+=upFee;downFees+=downFee;gross+=take*(upPrice+downPrice);fees+=upFee+downFee;buffer+=take*policy.executionBufferPerPair;
    upRemaining-=take;downRemaining-=take;
    if(upRemaining<=1e-9){ui++;upRemaining=up[ui]?.size||0}
    if(downRemaining<=1e-9){di++;downRemaining=down[di]?.size||0}
  }
  const spent=gross+fees,conservativeCost=spent+buffer,lockedProfit=pairs-conservativeCost;
  const netEdgePerPair=pairs?lockedProfit/pairs:0;
  const clearsFinalEdge=netEdgePerPair+1e-9>=policy.minNetEdgePerPair;
  const withinBudget=conservativeCost<=maxSpend+.001;
  const decision=pairs>0&&clearsFinalEdge&&withinBudget&&lockedProfit>=policy.minLockedProfit?"paper_complete_set":"observe";
  const reason=decision==="paper_complete_set"
    ?`Both legs fill from visible asks; fees and ${(policy.executionBufferPerPair*100).toFixed(1)}¢/pair execution reserve leave ${(netEdgePerPair*100).toFixed(2)}¢ net edge`
    :pairs<=0?`No executable pair cleared the ${(policy.minNetEdgePerPair*100).toFixed(1)}¢ net-edge floor after fees and execution reserve`:!clearsFinalEdge?`Final rounded cost fell below the ${(policy.minNetEdgePerPair*100).toFixed(1)}¢ net-edge floor`:!withinBudget?`Final rounded cost exceeded the $${maxSpend.toFixed(2)} market budget`:`Locked profit $${lockedProfit.toFixed(2)} was below the $${policy.minLockedProfit.toFixed(2)} minimum`;
  return {pairs,gross,fees,buffer,spent,conservativeCost,lockedProfit,netEdgePerPair,decision,reason,upGross,downGross,upFees,downFees};
}

export function currentCryptoMarketSlugs(unixNow:number){
  return (["BTC","ETH"] as const).flatMap(asset=>([5,15] as const).map(minutes=>{
    const seconds=minutes*60,start=Math.floor(unixNow/seconds)*seconds;
    return {asset,minutes,start,slug:`${asset.toLowerCase()}-updown-${minutes}m-${start}`};
  }));
}
