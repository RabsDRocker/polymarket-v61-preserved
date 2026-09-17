import {cryptoTakerFee} from "./execution.ts";
import {probabilityAboveTarget} from "./value-strategy.ts";

export const v6Policy={
  version:"v6-adaptive",
  startingBalance:1000,
  assets:["BTC"] as const,
  durations:[5,15] as const,
  mainEntrySecondsRemaining:120,
  mainEntryToleranceSeconds:25,
  impulseMinimumDollars:70,
  impulseMaximumDollars:100,
  requireFlowConfirmation:true,
  flowImbalanceMinimum:.08,
  tradingAllocationPerMarket:100,
  momentumAllocationFraction:.50,
  adaptiveBaseStake:20,
  adaptiveStrongStake:35,
  adaptiveStrongProbability:.78,
  minimumProbability:.62,
  minimumNetEdge:.04,
  minimumSecondsRemaining:{5:25,15:50},
  maximumEntrySecondsRemaining:{5:210,15:600},
  maximumSpread:.03,
  maximumQuoteAgeSeconds:2,
  minimumFillRatio:.95,
  executionReservePerShare:.01,
  microHedgeEnabled:true,
  extremeSkewProbability:.95,
  microHedgeDollars:2,
  maximumOpenExposureByDuration:{5:100,15:100},
  maximumCombinedExposure:160,
  dailyProfitTarget:null,
  dailyLossStop:200,
  exitConfidenceFloor:.48,
  exitLossFraction:.18,
  minimumHoldSeconds:12,
  reversalProbability:.72,
  reversalStake:25,
} as const;

export const v61Policy={
  ...v6Policy,
  version:"v6.1-adaptive",
  dailyLossStop:null,
  maximumEntrySecondsRemaining:{...v6Policy.maximumEntrySecondsRemaining,15:360},
} as const;

export type V6Duration=5|15;
export type V6Side="Up"|"Down";

export function orderFlowImbalance(bids:{size:string}[],asks:{size:string}[]){
  const bid=bids.reduce((s,x)=>s+Number(x.size||0),0),ask=asks.reduce((s,x)=>s+Number(x.size||0),0);
  return bid+ask>0?(bid-ask)/(bid+ask):0;
}

export function blendedUpProbability(input:{current:number;target:number;secondsRemaining:number;sigma:number;momentum30:number;momentum120:number;upFlow:number;downFlow:number;duration:V6Duration}){
  const structural=probabilityAboveTarget(input.current,input.target,input.secondsRemaining,input.sigma);
  const momentum=Math.tanh((input.momentum30*7000+input.momentum120*2500));
  const flow=Math.max(-1,Math.min(1,(input.upFlow-input.downFlow)/2));
  const crossWeight=input.duration===15?.07:.04;
  return Math.max(.01,Math.min(.99,structural*.78+(.5+momentum/2)*(.18-crossWeight)+(.5+flow/2)*.04+(.5+Math.tanh(input.momentum120*1800)/2)*crossWeight));
}

export function decideV6Entry(input:{duration:V6Duration;secondsRemaining:number;intervalMove:number;upProbability:number;upAsk:number;downAsk:number;upSpread:number;downSpread:number;upFlow:number;downFlow:number;availableCash:number;durationExposure:number;combinedExposure:number;dailyPnl:number},p:v6PolicyShape=v6Policy){
  if(p.dailyProfitTarget!==null&&input.dailyPnl>=p.dailyProfitTarget)return {action:"wait" as const,reason:"Daily paper-profit target reached"};
  if(p.dailyLossStop!==null&&input.dailyPnl<=-p.dailyLossStop)return {action:"wait" as const,reason:"Daily paper-loss stop reached"};
  if(input.secondsRemaining<p.minimumSecondsRemaining[input.duration]||input.secondsRemaining>p.maximumEntrySecondsRemaining[input.duration])return {action:"wait" as const,reason:"Outside adaptive executable window"};
  const side:V6Side=input.upProbability>=.5?"Up":"Down",probability=side==="Up"?input.upProbability:1-input.upProbability;
  const ask=side==="Up"?input.upAsk:input.downAsk,spread=side==="Up"?input.upSpread:input.downSpread,flow=side==="Up"?input.upFlow:input.downFlow;
  if(ask<=0||ask>=1)return {action:"wait" as const,reason:"No executable ask"};
  if(spread>p.maximumSpread)return {action:"wait" as const,reason:`Spread ${(spread*100).toFixed(1)}c exceeds ${(p.maximumSpread*100).toFixed(0)}c`};
  const nearMain=Math.abs(input.secondsRemaining-p.mainEntrySecondsRemaining)<=p.mainEntryToleranceSeconds;
  const impulse=Math.abs(input.intervalMove)>=p.impulseMinimumDollars;
  const directionAgrees=(input.intervalMove>=0&&side==="Up")||(input.intervalMove<0&&side==="Down");
  const flowAgrees=flow>=p.flowImbalanceMinimum;
  const deterministic=nearMain&&impulse&&directionAgrees&&(!p.requireFlowConfirmation||flowAgrees);
  const netEdge=probability-ask-cryptoTakerFee(1,ask)-p.executionReservePerShare;
  if(!deterministic&&(probability<p.minimumProbability||netEdge<p.minimumNetEdge))return {action:"wait" as const,side,probability,netEdge,reason:`Adaptive edge ${(netEdge*100).toFixed(1)}pp / confidence ${(probability*100).toFixed(1)}% not ready`};
  let dollars=deterministic?p.tradingAllocationPerMarket*p.momentumAllocationFraction:probability>=p.adaptiveStrongProbability?p.adaptiveStrongStake:p.adaptiveBaseStake;
  dollars=Math.min(dollars,input.availableCash,p.maximumOpenExposureByDuration[input.duration]-input.durationExposure,p.maximumCombinedExposure-input.combinedExposure);
  if(dollars<5)return {action:"wait" as const,reason:"Risk budget or paper cash is below $5"};
  return {action:"paper_buy" as const,side,probability,netEdge,dollars,deterministic,reason:deterministic?`Deterministic momentum: $${Math.abs(input.intervalMove).toFixed(0)} interval move, ${(flow*100).toFixed(0)}% supporting flow, near 2m`: `Adaptive value: ${(probability*100).toFixed(1)}% fair chance, ${(netEdge*100).toFixed(1)}pp executable edge`};
}

export type v6PolicyShape={
  version:string;dailyProfitTarget:number|null;dailyLossStop:number|null;
  minimumSecondsRemaining:{5:number;15:number};maximumEntrySecondsRemaining:{5:number;15:number};
  maximumSpread:number;mainEntrySecondsRemaining:number;mainEntryToleranceSeconds:number;
  impulseMinimumDollars:number;requireFlowConfirmation:boolean;flowImbalanceMinimum:number;
  minimumProbability:number;minimumNetEdge:number;executionReservePerShare:number;
  tradingAllocationPerMarket:number;momentumAllocationFraction:number;
  adaptiveBaseStake:number;adaptiveStrongStake:number;adaptiveStrongProbability:number;
  maximumOpenExposureByDuration:{5:number;15:number};maximumCombinedExposure:number;
  microHedgeEnabled:boolean;extremeSkewProbability:number;microHedgeDollars:number;
};

export function shouldMicroHedge(probability:number,p:v6PolicyShape=v6Policy){return p.microHedgeEnabled&&probability>=p.extremeSkewProbability}
