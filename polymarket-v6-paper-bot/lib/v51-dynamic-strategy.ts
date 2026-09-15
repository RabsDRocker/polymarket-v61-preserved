export const dynamicV51Policy={minimumEntryEdge:.03,exitAdvantage:.01,hedgeBudget:10,minimumFillRatio:.95,reversalConfidence:.65,minimumReversalExpectedProfit:.25,minimumReversalSeconds:20} as const;
export const scaledV53Policy={lowStake:10,mediumStake:20,highStake:30,mediumConfidence:.65,highConfidence:.8,minimumHoldSeconds:10,exitProbability:.45,maximumLossFraction:.2,strongUnderlyingHoldProbability:.85,reversalConfidence:.7,reversalBudget:20,minimumReversalExpectedProfit:.5,minimumReversalSeconds:30,dailyProfitTarget:50,dailyLossStop:200} as const;

const clamp=(n:number,min=0.02,max=0.98)=>Math.min(max,Math.max(min,n));

export function dynamicUpProbability(baseUp:number,momentumReturn:number,upBidDepth:number,upAskDepth:number){
  const momentum=Math.max(-.08,Math.min(.08,momentumReturn*80));
  const total=upBidDepth+upAskDepth,imbalance=total>0?(upBidDepth-upAskDepth)/total:0;
  return clamp(baseUp+momentum+imbalance*.04);
}

export function settlementOutcomes(input:{upShares:number;downShares:number;totalCost:number}){
  return {ifUp:input.upShares-input.totalCost,ifDown:input.downShares-input.totalCost,worst:Math.min(input.upShares,input.downShares)-input.totalCost};
}

export function chooseDynamicManagement(input:{heldSide:"Up"|"Down";shares:number;cost:number;upProbability:number;sellProceeds:number;oppositeShares:number;oppositeSpend:number}){
  const heldProbability=input.heldSide==="Up"?input.upProbability:1-input.upProbability;
  const oppositeProbability=1-heldProbability;
  const reversed=(input.heldSide==="Up"?input.upProbability<.5:input.upProbability>.5);
  const holdValue=heldProbability*input.shares;
  const oppositeExpectedProfit=oppositeProbability*input.oppositeShares-input.oppositeSpend;
  if(reversed&&input.sellProceeds>holdValue+dynamicV51Policy.exitAdvantage&&oppositeExpectedProfit>=.25)return {action:"flip" as const,reason:"Executable exit is better than holding and the reversed side has positive expected value",oppositeExpectedProfit};
  if(input.sellProceeds>holdValue+dynamicV51Policy.exitAdvantage)return {action:"sell" as const,reason:"Executable exit value exceeds probability-weighted hold value"};
  if(reversed&&input.oppositeShares>0){
    const before=settlementOutcomes({upShares:input.heldSide==="Up"?input.shares:0,downShares:input.heldSide==="Down"?input.shares:0,totalCost:input.cost});
    const after=settlementOutcomes({upShares:(input.heldSide==="Up"?input.shares:0)+(input.heldSide==="Down"?input.oppositeShares:0),downShares:(input.heldSide==="Down"?input.shares:0)+(input.heldSide==="Up"?input.oppositeShares:0),totalCost:input.cost+input.oppositeSpend});
    if(after.worst>before.worst)return {action:"hedge" as const,reason:"Opposite-side fill reduces worst-case settlement loss",before,after};
  }
  return {action:"hold" as const,reason:"Neither exit nor opposite-side hedge improves the deterministic position test"};
}

export function choosePostExitReversal(input:{soldSide:"Up"|"Down";upProbability:number;oppositeShares:number;oppositeSpend:number;secondsRemaining:number}){
  const oppositeSide:"Up"|"Down"=input.soldSide==="Up"?"Down":"Up",probability=oppositeSide==="Up"?input.upProbability:1-input.upProbability,expectedProfit=probability*input.oppositeShares-input.oppositeSpend;
  if(input.secondsRemaining<dynamicV51Policy.minimumReversalSeconds)return {action:"wait" as const,reason:"Too little time remained for a post-exit reversal"};
  if(probability<dynamicV51Policy.reversalConfidence)return {action:"wait" as const,reason:"Opposite-side confidence had not reached the reversal threshold"};
  if(expectedProfit<dynamicV51Policy.minimumReversalExpectedProfit)return {action:"wait" as const,reason:"Opposite-side executable expected value was insufficient"};
  return {action:"reverse" as const,side:oppositeSide,probability,expectedProfit,reason:"Post-exit signal reversal cleared confidence and executable-value tests"};
}

export function scaledV53Stake(probability:number){return probability>=scaledV53Policy.highConfidence?scaledV53Policy.highStake:probability>=scaledV53Policy.mediumConfidence?scaledV53Policy.mediumStake:scaledV53Policy.lowStake}

export function chooseScaledV53Management(input:{heldSide:"Up"|"Down";shares:number;cost:number;upProbability:number;underlyingUpProbability:number;sellProceeds:number;oppositeShares:number;oppositeSpend:number;secondsRemaining:number;heldSeconds:number}){
  if(input.heldSeconds<scaledV53Policy.minimumHoldSeconds)return {action:"hold" as const,reason:"Minimum hold period prevents immediate spread churn"};
  const heldProbability=input.heldSide==="Up"?input.upProbability:1-input.upProbability,underlyingHeldProbability=input.heldSide==="Up"?input.underlyingUpProbability:1-input.underlyingUpProbability,oppositeProbability=1-heldProbability,lossFraction=input.cost>0?(input.sellProceeds-input.cost)/input.cost:0,strongUnderlyingEvidence=underlyingHeldProbability>=scaledV53Policy.strongUnderlyingHoldProbability,confidenceExit=heldProbability<scaledV53Policy.exitProbability&&!strongUnderlyingEvidence,lossExit=lossFraction<=-scaledV53Policy.maximumLossFraction&&!strongUnderlyingEvidence,exit=confidenceExit||lossExit,expectedProfit=oppositeProbability*input.oppositeShares-input.oppositeSpend;
  if(strongUnderlyingEvidence&&lossFraction<=-scaledV53Policy.maximumLossFraction)return {action:"hold" as const,reason:"Strong independent BTC target-gap evidence overrides the price-only stop"};
  if(!exit)return {action:"hold" as const,reason:"Held-side confidence and executable loss remain inside limits"};
  if(input.secondsRemaining>=scaledV53Policy.minimumReversalSeconds&&oppositeProbability>=scaledV53Policy.reversalConfidence&&expectedProfit>=scaledV53Policy.minimumReversalExpectedProfit)return {action:"flip" as const,reason:"Controlled exit and strong opposite-side value justify one reversal",oppositeExpectedProfit:expectedProfit};
  return {action:"sell" as const,reason:"Held-side confidence or executable loss crossed the scaled exit limit"};
}

export function chooseScaledV53PostExit(input:{soldSide:"Up"|"Down";upProbability:number;oppositeShares:number;oppositeSpend:number;secondsRemaining:number}){
  const side:"Up"|"Down"=input.soldSide==="Up"?"Down":"Up",probability=side==="Up"?input.upProbability:1-input.upProbability,expectedProfit=probability*input.oppositeShares-input.oppositeSpend;
  return input.secondsRemaining>=scaledV53Policy.minimumReversalSeconds&&probability>=scaledV53Policy.reversalConfidence&&expectedProfit>=scaledV53Policy.minimumReversalExpectedProfit?{action:"reverse" as const,side,probability,expectedProfit,reason:"Strong post-exit reversal cleared scaled value controls"}:{action:"wait" as const,reason:"Post-exit reversal did not clear scaled controls"};
}
