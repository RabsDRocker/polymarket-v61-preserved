import {cryptoTakerFee} from "./execution.ts";
import {probabilityAboveTarget} from "./value-strategy.ts";

export const selectiveV5Policy={
  version:"v5-selective",
  startingBalance:1000,
  minutes:5,
  decisionStartSecondsRemaining:160,
  decisionEndSecondsRemaining:120,
  minimumHistorySeconds:120,
  maximumTargetDelaySeconds:12,
  dollarsPerDirectionalTrade:10,
  maximumCompleteSetSpend:25,
  maximumSpread:1,
  executionReservePerShare:.01,
  minimumNetEdge:{BTC:-1,ETH:.08},
  probabilityShrink:{BTC:.85,ETH:.75},
  minimumFillRatio:.95,
  maximumOpenExposure:100,
  dailyLossStop:300
} as const;

export type SelectiveAsset="BTC"|"ETH";

export function timeWeightedAverage(points:{at:number;price:number}[],endAt:number,lookbackMs=60_000){
  const ordered=[...points].filter(point=>Number.isFinite(point.at)&&Number.isFinite(point.price)&&point.price>0&&point.at<=endAt).sort((a,b)=>a.at-b.at);
  const start=endAt-lookbackMs,anchor=[...ordered].reverse().find(point=>point.at<=start);
  if(!anchor)return 0;
  let value=anchor.price,cursor=start,weighted=0;
  for(const point of ordered){if(point.at<=start){value=point.price;continue}if(point.at>endAt)break;weighted+=value*(point.at-cursor);cursor=point.at;value=point.price}
  weighted+=value*(endAt-cursor);
  return weighted/lookbackMs;
}

export function currentDecisionPrice(points:{at:number;price:number}[],endAt:number){
  const twap=timeWeightedAverage(points,endAt);
  if(twap>0)return twap;
  return [...points].reverse().find(point=>point.at<=endAt&&Number.isFinite(point.price)&&point.price>0)?.price||0;
}

export function shrinkProbability(raw:number,asset:SelectiveAsset){
  const bounded=Math.min(.999,Math.max(.001,raw));
  return .5+(bounded-.5)*selectiveV5Policy.probabilityShrink[asset];
}

export function decideSelectiveV5Entry(input:{asset:SelectiveAsset;secondsRemaining:number;targetDelaySeconds:number;historySeconds:number;current:number;target:number;sigmaPerRootSecond:number;upAsk:number;downAsk:number;upSpread:number;downSpread:number;availableCash:number;openExposure:number;dailyRealizedPnl:number}){
  const p=selectiveV5Policy;
  if(input.targetDelaySeconds>p.maximumTargetDelaySeconds)return {action:"wait" as const,reason:"Opening Chainlink target arrived too late"};
  if(input.historySeconds<p.minimumHistorySeconds||input.sigmaPerRootSecond<=0)return {action:"wait" as const,reason:"Still collecting the first two minutes of Chainlink evidence"};
  if(input.secondsRemaining>p.decisionStartSecondsRemaining||input.secondsRemaining<p.decisionEndSecondsRemaining)return {action:"wait" as const,reason:"Outside the calibrated halfway decision window"};
  if(input.dailyRealizedPnl<=-p.dailyLossStop)return {action:"wait" as const,reason:"Daily paper-loss stop reached"};
  if(input.openExposure+p.dollarsPerDirectionalTrade>p.maximumOpenExposure)return {action:"wait" as const,reason:"Open paper exposure cap reached"};
  const rawUp=probabilityAboveTarget(input.current,input.target,input.secondsRemaining,input.sigmaPerRootSecond);
  const calibratedUp=shrinkProbability(rawUp,input.asset),side:"Up"|"Down"=calibratedUp>=.5?"Up":"Down";
  const probability=side==="Up"?calibratedUp:1-calibratedUp,ask=side==="Up"?input.upAsk:input.downAsk,spread=side==="Up"?input.upSpread:input.downSpread;
  if(ask<=0||ask>=1)return {action:"wait" as const,reason:"No executable ask was available"};
  const diagnostics={side,rawUpProbability:rawUp,upProbability:calibratedUp,probability};
  if(spread>p.maximumSpread)return {action:"wait" as const,...diagnostics,reason:`Spread ${(spread*100).toFixed(1)}¢ exceeded the ${(p.maximumSpread*100).toFixed(0)}¢ limit`};
  const feePerShare=cryptoTakerFee(1,ask),netEdge=probability-ask-feePerShare-p.executionReservePerShare,minimum=p.minimumNetEdge[input.asset];
  if(netEdge<minimum)return {action:"wait" as const,...diagnostics,netEdge,minimumNetEdge:minimum,reason:`Net edge ${(netEdge*100).toFixed(1)}pp was below ${input.asset}'s ${(minimum*100).toFixed(0)}pp floor`};
  const dollars=Math.min(p.dollarsPerDirectionalTrade,input.availableCash);
  if(dollars<5)return {action:"wait" as const,reason:"Less than $5 paper cash remained"};
  return {action:"paper_buy" as const,...diagnostics,ask,netEdge,minimumNetEdge:minimum,dollars,reason:`${input.asset} ${side}: ${(probability*100).toFixed(1)}% conservative fair chance versus ${(ask*100).toFixed(1)}¢ ask; ${(netEdge*100).toFixed(1)}pp net edge`};
}
