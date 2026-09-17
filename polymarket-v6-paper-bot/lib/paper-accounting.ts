export function paperSaleAccounting(shares:number,cost:number,soldShares:number,proceeds:number){
  if(![shares,cost,soldShares,proceeds].every(Number.isFinite)||shares<=0||cost<0||soldShares<=0||soldShares>shares+1e-8||proceeds<0)throw new Error("Invalid paper sale accounting");
  const sold=Math.min(soldShares,shares),allocatedCost=cost*sold/shares;
  const remainingShares=Math.max(0,shares-sold),closed=remainingShares<=1e-10;
  return {realizedPnl:proceeds-allocatedCost,remainingShares:closed?0:remainingShares,remainingCost:closed?0:cost-allocatedCost,closed};
}
