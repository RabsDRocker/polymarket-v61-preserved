import {DatabaseSync} from "node:sqlite";

export type MirrorReportRow={
  action_id:number;mode:string;reason:string;created_at:string;
  market_slug:string|null;side:string|null;action_kind:string|null;
  amount:number|null;price_limit:number|null;status:string|null;
  filled_usd:number|null;filled_shares:number|null;error:string|null;updated_at:string|null;
};

export function readMirrorReport(){
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync("/var/lib/polymarket-preserved-fresh/execution.db",{readOnly:true});
    db.exec("PRAGMA busy_timeout=1000");
    return db.prepare(`
      SELECT a.action_id,a.mode,a.reason,a.created_at,
             i.market_slug,i.side,i.action_kind,i.amount,i.price_limit,
             i.status,i.filled_usd,i.filled_shares,i.error,i.updated_at
      FROM mirror_audit a
      LEFT JOIN intents i ON i.idempotency_key='v61-action:'||a.action_id
      ORDER BY a.action_id DESC LIMIT 40
    `).all() as unknown as MirrorReportRow[];
  }catch{return [];}
  finally{db?.close();}
}

type Activity={timestamp:number|string;type:string;side?:string;slug:string;usdcSize:number|string};
type Timeframe={pnl:number;markets:number;wins:number;losses:number};
const blank=():Timeframe=>({pnl:0,markets:0,wins:0,losses:0});

export async function readLiveTimeframeContribution(){
  const unavailable={available:false,updatedAt:null as string|null,recent:{wins:0,markets:0},5:blank(),15:blank()};
  try{
    const url="https://data-api.polymarket.com/activity?user=0x9D52d2C79854A06c3fc62DFE385Cc2Af4C406907&limit=500&offset=0";
    const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(4000)});
    if(!response.ok)return unavailable;
    const activation=Date.parse("2026-09-17T04:55:00.753047+00:00")/1000;
    const groups=new Map<string,{minutes:5|15;end:number;buy:number;sell:number;redeem:number}>();
    for(const row of await response.json() as Activity[]){
      const timestamp=Number(row.timestamp);
      if(timestamp<activation)continue;
      const match=row.slug?.match(/^btc-updown-(5|15)m-(\d+)$/);
      if(!match)continue;
      const minutes=Number(match[1]) as 5|15;
      const market=groups.get(row.slug)||{minutes,end:Number(match[2])+minutes*60,buy:0,sell:0,redeem:0};
      const cash=Number(row.usdcSize||0);
      if(row.type==="TRADE"&&row.side==="BUY")market.buy+=cash;
      else if(row.type==="TRADE"&&row.side==="SELL")market.sell+=cash;
      else if(row.type==="REDEEM")market.redeem+=cash;
      groups.set(row.slug,market);
    }
    const result={available:true,updatedAt:new Date().toISOString(),recent:{wins:0,markets:0},5:blank(),15:blank()};
    const now=Date.now()/1000;
    const recent=[...groups.values()].filter(m=>m.end<now-30&&m.buy>0).sort((a,b)=>b.end-a.end).slice(0,20);
    result.recent={markets:recent.length,wins:recent.filter(m=>m.sell+m.redeem-m.buy>0.000001).length};
    for(const market of groups.values()){
      if(market.end>=now-30)continue;
      const pnl=market.sell+market.redeem-market.buy,bucket=result[market.minutes];
      bucket.pnl+=pnl;bucket.markets++;
      if(pnl>=0)bucket.wins++;else bucket.losses++;
    }
    return result;
  }catch{return unavailable;}
}
