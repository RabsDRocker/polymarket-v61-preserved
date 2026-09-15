import {cryptoTakerFee} from "./execution.ts";

export type SpotPoint={at:number;price:number};
export const valueStrategyPolicy={startingBalance:1000,dollarsPerTrade:10,minimumNetEdge:.06,executionReserve:.01,maximumSpread:.06,minimumHistorySeconds:30,maximumTargetDelaySeconds:12,minimumSecondsRemaining:25,maximumEntrySeconds:{5:180,15:600},dailyLossStop:25} as const;

function normalCdf(x:number){const sign=x<0?-1:1,z=Math.abs(x)/Math.sqrt(2),t=1/(1+.3275911*z),erf=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-z*z);return .5*(1+sign*erf)}
export function estimateVolatility(points:SpotPoint[]){if(points.length<3)return 0;let varianceTime=0,totalTime=0;for(let i=1;i<points.length;i++){const dt=(points[i].at-points[i-1].at)/1000;if(dt<=0||points[i].price<=0||points[i-1].price<=0)continue;const r=Math.log(points[i].price/points[i-1].price);varianceTime+=r*r;totalTime+=dt}return totalTime>0?Math.sqrt(varianceTime/totalTime):0}
export function probabilityAboveTarget(current:number,target:number,secondsRemaining:number,sigmaPerRootSecond:number){if(current<=0||target<=0||secondsRemaining<=0||sigmaPerRootSecond<=0)return current>target?1:current<target?0:.5;return normalCdf(Math.log(current/target)/(sigmaPerRootSecond*Math.sqrt(secondsRemaining)))}

export function decideValueEntry(input:{minutes:5|15;secondsRemaining:number;targetDelaySeconds:number;historySeconds:number;current:number;target:number;sigmaPerRootSecond:number;upAsk:number;downAsk:number;upSpread:number;downSpread:number;availableCash:number;dailyRealizedPnl:number}){
  const p=valueStrategyPolicy;if(input.targetDelaySeconds>p.maximumTargetDelaySeconds)return {action:"wait" as const,reason:"Reference target was captured too late"};
  if(input.historySeconds<p.minimumHistorySeconds||input.sigmaPerRootSecond<=0)return {action:"wait" as const,reason:"Not enough independent spot-price history"};
  if(input.secondsRemaining<=p.minimumSecondsRemaining||input.secondsRemaining>p.maximumEntrySeconds[input.minutes])return {action:"wait" as const,reason:"Outside the value-entry window"};
  if(input.dailyRealizedPnl<=-p.dailyLossStop)return {action:"wait" as const,reason:"Daily paper-loss stop reached"};
  const upProbability=probabilityAboveTarget(input.current,input.target,input.secondsRemaining,input.sigmaPerRootSecond),side:"Up"|"Down"=upProbability>=.5?"Up":"Down",probability=side==="Up"?upProbability:1-upProbability,ask=side==="Up"?input.upAsk:input.downAsk,spread=side==="Up"?input.upSpread:input.downSpread;
  if(ask<=0||ask>=1||spread>p.maximumSpread)return {action:"wait" as const,reason:"Executable price or spread did not qualify"};
  const netEdge=probability-ask-cryptoTakerFee(1,ask)-p.executionReserve;if(netEdge<p.minimumNetEdge)return {action:"wait" as const,reason:`Independent edge ${(netEdge*100).toFixed(1)}% was below ${(p.minimumNetEdge*100).toFixed(0)}%`};
  const dollars=Math.min(p.dollarsPerTrade,input.availableCash);if(dollars<5)return {action:"wait" as const,reason:"Less than $5 paper cash remained"};
  return {action:"paper_buy" as const,side,probability,ask,netEdge,dollars,reason:`${side} fair probability ${(probability*100).toFixed(1)}% versus ${(ask*100).toFixed(1)}¢ ask after fees and reserve`};
}
