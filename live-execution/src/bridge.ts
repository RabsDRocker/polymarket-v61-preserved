import {DatabaseSync} from "node:sqlite";
import {percentageOfCapital,v61ActionKind,v61LiveEntryPercent} from "./core.ts";
import {migrate,openStore,queueIntent,setSetting,setting} from "./store.ts";

const paperPath=process.env.V61_PAPER_DB||"/opt/polybot/polymarket-v6-paper-bot/data/v61-adaptive.db";
const slippageBps=Number(process.env.MAX_SLIPPAGE_BPS||100),signalTtlMs=Number(process.env.MAX_SIGNAL_AGE_MS||5000);
const paper=new DatabaseSync(paperPath,{readOnly:true}),live=migrate(openStore());
paper.exec("PRAGMA busy_timeout=5000");live.exec("PRAGMA busy_timeout=5000");
let watermark=Number(setting(live,"v61_action_watermark")||0);
if(!watermark){watermark=Number((paper.prepare("SELECT COALESCE(MAX(id),0) n FROM actions").get() as any).n);setSetting(live,"v61_action_watermark",String(watermark));console.log(`Bridge initialized at V6.1 action ${watermark}`);}
if(process.env.BRIDGE_INIT_ONLY==="1"){paper.close();live.close();process.exit(0);}
let running=true;process.on("SIGTERM",()=>running=false);process.on("SIGINT",()=>running=false);
while(running){
  const rows=paper.prepare("SELECT a.*,m.up_token,m.down_token FROM actions a JOIN markets m ON m.slug=a.slug WHERE a.id>? ORDER BY a.id").all(watermark) as any[];
  for(const row of rows){
    watermark=row.id;setSetting(live,"v61_action_watermark",String(watermark));
    const mapping=v61ActionKind(row.phase);if(!mapping)continue;
    if(mapping.actionKind==="hedge"&&process.env.LIVE_MICRO_HEDGE_ENABLED!=="1")continue;
    const tokenId=row.outcome==="Up"?row.up_token:row.down_token;
    const priceLimit=mapping.side==="BUY"?Math.min(.99,Math.ceil(Number(row.avg_price)*(1+slippageBps/10_000)*100)/100):Math.max(.01,Math.floor(Number(row.avg_price)*(1-slippageBps/10_000)*100)/100);
    const equity=Number(setting(live,"equity_usd")||0);
    const percent=v61LiveEntryPercent(row.phase,Number(row.spent));
    const amount=mapping.side==="BUY"?percentageOfCapital(equity,percent):Number(row.shares);
    if(mapping.side==="BUY"&&amount<=0)continue;
    const created=Date.parse(row.created_at);if(Date.now()-created>signalTtlMs-500)continue;
    queueIntent(live,{idempotencyKey:`v61-action:${row.id}`,tokenId:String(tokenId),marketSlug:row.slug,side:mapping.side,actionKind:mapping.actionKind,amount,priceLimit,signalCreatedAt:row.created_at,expiresAt:new Date(created+signalTtlMs).toISOString()});
  }
  await new Promise(r=>setTimeout(r,100));
}
paper.close();live.close();
