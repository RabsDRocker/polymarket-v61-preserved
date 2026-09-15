export type ProbabilityPoint={at:number;probability:number};
export const hedgedAccumulatorPolicy={
  insuranceDollars:10,
  insuranceMaximumProbability:.35,
  insuranceMaximumAsk:.40,
  insuranceMaximumSpread:.08,
  insuranceEarliestFraction:.10,
  insuranceLatestFraction:.55,
  noEntryFinalSeconds:20,
  tiers:[
    {name:"leader_72",minimumProbability:.72,targetMarketDollars:25,confirmationMs:3000,minimumRise:.01},
    {name:"leader_82",minimumProbability:.82,targetMarketDollars:45,confirmationMs:2500,minimumRise:.005},
    {name:"leader_90",minimumProbability:.90,targetMarketDollars:60,confirmationMs:1500,minimumRise:0},
  ],
} as const;

export function decideInsurance(input:{elapsedFraction:number;secondsRemaining:number;upProbability:number;downProbability:number;upAsk:number;downAsk:number;upSpread:number;downSpread:number}){
  const p=hedgedAccumulatorPolicy;
  if(input.secondsRemaining<=p.noEntryFinalSeconds||input.elapsedFraction<p.insuranceEarliestFraction||input.elapsedFraction>p.insuranceLatestFraction)return {action:"wait" as const,reason:"Outside the insurance-entry window"};
  const side:"Up"|"Down"=input.upProbability<=input.downProbability?"Up":"Down",probability=side==="Up"?input.upProbability:input.downProbability,ask=side==="Up"?input.upAsk:input.downAsk,spread=side==="Up"?input.upSpread:input.downSpread;
  if(probability>p.insuranceMaximumProbability||ask>p.insuranceMaximumAsk||spread>p.insuranceMaximumSpread)return {action:"wait" as const,reason:"Cheap side was not inexpensive and liquid enough"};
  return {action:"buy_insurance" as const,side,probability,dollars:p.insuranceDollars,reason:`Small ${side} insurance at ${(probability*100).toFixed(1)}% implied probability`};
}

export function decideLeaderAdd(input:{now:number;secondsRemaining:number;upProbability:number;downProbability:number;upHistory:ProbabilityPoint[];downHistory:ProbabilityPoint[];executedTiers:string[];currentMarketDollars:number}){
  const p=hedgedAccumulatorPolicy;if(input.secondsRemaining<=p.noEntryFinalSeconds)return {action:"wait" as const,reason:"Inside the final no-entry window"};
  const side:"Up"|"Down"=input.upProbability>=input.downProbability?"Up":"Down",probability=side==="Up"?input.upProbability:input.downProbability,history=side==="Up"?input.upHistory:input.downHistory;
  const eligible=[...p.tiers].reverse().find(tier=>probability>=tier.minimumProbability&&!input.executedTiers.includes(tier.name));
  if(!eligible)return {action:"wait" as const,reason:"No unfilled confidence tier is active"};
  const recent=history.filter(point=>point.at>=input.now-eligible.confirmationMs),earliest=recent[0];
  if(recent.length<3||!earliest||recent.some(point=>point.probability<eligible.minimumProbability-.02)||probability-earliest.probability<eligible.minimumRise)return {action:"wait" as const,reason:"Leader probability was not stable and rising long enough"};
  const dollars=Math.max(0,eligible.targetMarketDollars-input.currentMarketDollars);if(dollars<5)return {action:"wait" as const,reason:"Confidence tier exposure was already reached"};
  return {action:"buy_leader" as const,side,probability,tier:eligible.name,dollars,reason:`${side} held ${(probability*100).toFixed(1)}% probability through ${eligible.name.replace("leader_","")}% confirmation`};
}
