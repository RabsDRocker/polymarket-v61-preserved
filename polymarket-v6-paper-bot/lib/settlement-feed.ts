export type SettlementPoint={at:number;price:number};
export function parseSettlementFrame(frame:any,now=Date.now()):SettlementPoint|null{
  const p=frame?.payload;
  if(frame?.topic!=='crypto_prices_twap_sixty'||p?.symbol?.toLowerCase()!=='btc/usd'||p.window_s!==60)return null;
  const point={at:Number(p.timestamp),price:Number(p.value)};
  if(!Number.isFinite(point.at)||!Number.isFinite(point.price)||point.price<=0||now-point.at>5000||point.at>now+1000)return null;
  return point;
}
export function settlementAnchor(points:SettlementPoint[],startMs:number){
  return points.find(p=>p.at===startMs)?.price||0;
}
