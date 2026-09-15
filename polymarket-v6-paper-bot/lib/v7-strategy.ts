import {v61Policy} from "./v6-strategy.ts";

export const v7Policy={
  ...v61Policy,
  version:"v7-balanced-accumulator",
  openingWindowSeconds:60,
  openingDollarsPerSide:20,
  additionCooldownSeconds:30,
  microHedgeEnabled:false,
  allowSelling:false,
} as const;

export function v7MissingOpeningSides(outcomes:string[]){
  return (["Up","Down"] as const).filter(side=>!outcomes.includes(side));
}

export function v7OpeningFillAccepted(fillRatio:number){
  return fillRatio>=v7Policy.minimumFillRatio;
}

export function v7AdditionDollars(probability:number){
  const p=v7Policy,span=.99-p.minimumProbability;
  const confidence=Math.max(0,Math.min(1,(probability-p.minimumProbability)/span));
  return Math.round((p.adaptiveBaseStake+(p.adaptiveStrongStake-p.adaptiveBaseStake)*confidence)*100)/100;
}
