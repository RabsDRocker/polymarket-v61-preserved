import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";

const DB=process.env.POLYMARKET_LIVE_DB||"/var/lib/polymarket-live/execution.db";
const KILL=process.env.POLYMARKET_LIVE_KILL||"/var/lib/polymarket-live/KILL_SWITCH";
export type LiveStatus={available:boolean;armed:boolean;healthy:boolean;collateralUsd:number;positionValueUsd:number;equityUsd:number;exposureUsd:number;dailyPnlUsd:number;dailyLossLimitUsd:number;openOrders:number;accepted:number;rejected:number;unknown:number;updatedAt:string|null};
export function readLiveStatus():LiveStatus{
  const empty={available:false,armed:false,healthy:false,collateralUsd:0,positionValueUsd:0,equityUsd:0,exposureUsd:0,dailyPnlUsd:0,dailyLossLimitUsd:0,openOrders:0,accepted:0,rejected:0,unknown:0,updatedAt:null};
  if(!fs.existsSync(DB))return empty;
  try{const db=new DatabaseSync(DB,{readOnly:true});db.exec("PRAGMA busy_timeout=1000");const settings=Object.fromEntries((db.prepare("SELECT key,value FROM settings").all() as any[]).map(x=>[x.key,x.value])),counts=Object.fromEntries((db.prepare("SELECT status,COUNT(*) n FROM intents GROUP BY status").all() as any[]).map(x=>[x.status,Number(x.n)]));db.close();const heartbeat=String(settings.service_heartbeat_at||""),healthy=Date.now()-Date.parse(heartbeat)<7000,armed=!fs.existsSync(KILL)&&settings.kill_switch==="disengaged";return {available:true,armed,healthy,collateralUsd:Number(settings.collateral_usd||0),positionValueUsd:Number(settings.current_value_usd||0),equityUsd:Number(settings.equity_usd||0),exposureUsd:Number(settings.open_exposure_usd||0),dailyPnlUsd:Number(settings.daily_pnl_usd||0),dailyLossLimitUsd:Number(settings.max_daily_loss_usd||0),openOrders:Number(settings.exchange_open_orders||0),accepted:Number(counts.accepted||0),rejected:Number(counts.rejected||0),unknown:Number(counts.unknown||0),updatedAt:String(settings.last_reconciled_at||"")||null};}catch{return empty;}
}
