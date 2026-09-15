import {
  chooseOriginalV3Winner,
  isOriginalV3HalfwayDecisionTime,
  originalV3Policy,
  sizeOriginalV3Recovery
} from "./recovery-v3-original-strategy.ts";
export {extractChainlinkPoints,isFeedFresh,missingOpeningSides} from "./recovery-v3-original-strategy.ts";

// Compatibility fields are neutral and exist only because V3, V4, and the
// original V3 share one paper-feed engine. The preserved original rules remain
// the source of every trading value below.
export const recoveryPolicy={
  ...originalV3Policy,
  minimumProbabilityEdge:0,
  lateConfirmationEnabled:true,
  maxOpeningWorstCaseLoss:1000,
  minimumEquityToTrade:0
} as const;

export const chooseLateWinner=chooseOriginalV3Winner;
export const isHalfwayDecisionTime=isOriginalV3HalfwayDecisionTime;
export function recoveryBudgetForProbability(){return originalV3Policy.maxRecoveryDollars}
export function sizeRecoveryBuy(input:Parameters<typeof sizeOriginalV3Recovery>[0]&{modelProbability?:number}){
  return sizeOriginalV3Recovery(input);
}
