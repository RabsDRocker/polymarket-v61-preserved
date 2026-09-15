export const conservativeMirrorPolicy = {
  maxProfiles: 2,
  dollarsPerBuy: 25,
  maxOutcomeExposure: 50,
  maxMarketExposure: 75,
  maxPortfolioExposure: 300,
} as const;

export function sizeConservativeBuy(input:{
  availableCash:number;
  portfolioExposure:number;
  marketExposure:number;
  outcomeExposure:number;
  price:number;
}) {
  const policy=conservativeMirrorPolicy;
  const dollars=Math.max(0,Math.min(
    policy.dollarsPerBuy,
    input.availableCash,
    policy.maxPortfolioExposure-input.portfolioExposure,
    policy.maxMarketExposure-input.marketExposure,
    policy.maxOutcomeExposure-input.outcomeExposure,
  ));
  if(dollars<5) return {dollars:0,reason:"Less than the $5 minimum realistic order remained"};
  return {dollars,reason:"$25 mirror buy within portfolio, market, and outcome caps; no entry-price band"};
}

export function sizeProfileMirrorBuy(input:Parameters<typeof sizeConservativeBuy>[0]&{sourceUsdc:number;copyRatio?:number}) {
  if(!Number.isFinite(input.sourceUsdc)||input.sourceUsdc<=0) {
    return {dollars:0,reason:"Source buy did not contain a valid positive notional"};
  }
  if(input.price<=.01&&input.sourceUsdc<5) return {dollars:0,reason:"Disputed 1-cent public-feed dust was not present in the profile's aggregate position"};
  const ratio=Number.isFinite(input.copyRatio)?Math.max(0,input.copyRatio!):1;
  const dollars=Math.min(input.sourceUsdc*ratio,input.availableCash);
  if(dollars<.01) return {dollars:0,reason:"Paper cash was exhausted"};
  return {dollars,reason:`Fund-ratio copy at ${(ratio*100).toFixed(2)}% of the $${input.sourceUsdc.toFixed(2)} source action`};
}
