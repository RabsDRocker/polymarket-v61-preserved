import fs from "node:fs";
import {RateLimitError,RequestRejectedError,SigningError,UserInputError} from "@polymarket/client";
import {assertActionDependency,assertRiskBudget,effectiveBuyAmount,executableSellShares,meetsMinimumShares,percentageOfCapital,safeError,validateIntent,type Limits} from "./core.ts";
import {createExchange} from "./sdk.ts";
import {KILL_FILE,killed,migrate,nextIntent,openStore,recordAcceptedFill,recoverInterruptedSubmissions,setSetting,setting,transition} from "./store.ts";

const limits:Limits={
  maxOrderUsd:Number(process.env.MAX_ORDER_USD||1000),
  maxTotalExposureUsd:Number(process.env.MAX_TOTAL_EXPOSURE_USD||1000),
  maxDailyLossUsd:Number(process.env.MAX_DAILY_LOSS_USD||1000),
  maxSignalAgeMs:Number(process.env.MAX_SIGNAL_AGE_MS||5000),
};
const maxOrderPercent=Number(process.env.MAX_ORDER_BALANCE_PCT||25);
const maxExposurePercent=Number(process.env.MAX_TOTAL_EXPOSURE_PCT||75);
const maxDailyLossPercent=Number(process.env.MAX_DAILY_LOSS_PCT||20);
function limitsForEquity(equityUsd:number):Limits{return {...limits,
  maxOrderUsd:Math.min(limits.maxOrderUsd,percentageOfCapital(equityUsd,maxOrderPercent)),
  maxTotalExposureUsd:Math.min(limits.maxTotalExposureUsd,percentageOfCapital(equityUsd,maxExposurePercent)),
  maxDailyLossUsd:Math.min(limits.maxDailyLossUsd,percentageOfCapital(equityUsd,maxDailyLossPercent)),
};}
function publishLimits(equityUsd:number){const active=limitsForEquity(equityUsd);setSetting(db,"max_order_usd",String(active.maxOrderUsd));setSetting(db,"max_total_exposure_usd",String(active.maxTotalExposureUsd));setSetting(db,"max_daily_loss_usd",String(active.maxDailyLossUsd));return active;}
const maxAcceptedOrders=Number(process.env.MAX_ACCEPTED_ORDERS||1);
function knownRejection(error:unknown){return error instanceof UserInputError||error instanceof SigningError||error instanceof RateLimitError||(error instanceof RequestRejectedError&&error.status>=400&&error.status<500);}
if(process.env.LIVE_TRADING_ENABLED!=="I_UNDERSTAND_REAL_ORDERS") throw new Error("live execution is not enabled");
const db=migrate(openStore());
const interrupted=recoverInterruptedSubmissions(db);
const unknown=Number((db.prepare("SELECT COUNT(*) n FROM intents WHERE status='unknown'").get() as any).n);
if(interrupted||unknown){fs.writeFileSync(KILL_FILE,"Unknown order outcome; reconcile manually before restart.\n",{mode:0o640});throw new Error("unknown order outcome requires manual reconciliation");}
if(killed(db)) throw new Error(`kill switch engaged (${KILL_FILE})`);
const exchange=await createExchange();
let running=true, uncertain=false;
process.on("SIGTERM",()=>running=false); process.on("SIGINT",()=>running=false);

async function reconcile() {
  const geo=await exchange.geoblock();
  if(geo.blocked) throw new Error(`trading geoblocked in ${geo.country}-${geo.region}`);
  const open=await exchange.openOrders(), now=new Date().toISOString();
  const [portfolio,collateral]=await Promise.all([exchange.portfolio(),exchange.collateralUsd()]);
  setSetting(db,"open_exposure_usd",String(portfolio.openExposureUsd));
  setSetting(db,"collateral_usd",String(collateral));setSetting(db,"current_value_usd",String(portfolio.currentValueUsd));setSetting(db,"equity_usd",String(collateral+portfolio.currentValueUsd));setSetting(db,"exchange_open_orders",String(open.length));setSetting(db,"last_reconciled_at",now);
  const day=now.slice(0,10),equity=collateral+portfolio.currentValueUsd;
  if(setting(db,"equity_day")!==day){setSetting(db,"equity_day",day);setSetting(db,"day_start_equity_usd",String(equity));}
  setSetting(db,"daily_pnl_usd",String(equity-Number(setting(db,"day_start_equity_usd")||equity)));
  publishLimits(equity);
  db.exec("BEGIN IMMEDIATE");
  try {
    for(const order of open) db.prepare("INSERT INTO exchange_orders(order_id,status,raw_json,observed_at) VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,raw_json=excluded.raw_json,observed_at=excluded.observed_at").run(String(order.id||order.orderId),String(order.status||"open"),JSON.stringify(order),now);
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
}

await reconcile();let lastReconciledAt=Date.now(),lastHeartbeatAt=0,lastReconcileError="";
while(running){
  if(Date.now()-lastHeartbeatAt>=2000){setSetting(db,"service_heartbeat_at",new Date().toISOString());lastHeartbeatAt=Date.now();}
  if(killed(db)){await exchange.cancelAll();break;}
  const accepted=Number((db.prepare("SELECT COUNT(*) n FROM intents WHERE status='accepted'").get() as any).n);
  if(maxAcceptedOrders>0&&accepted>=maxAcceptedOrders){fs.writeFileSync(KILL_FILE,"Accepted-order limit reached.\n",{mode:0o640});break;}
  const intent=nextIntent(db); if(!intent){if(Date.now()-lastReconciledAt>=15000){
    try{
      await reconcile();lastReconciledAt=Date.now();
      if(lastReconcileError){setSetting(db,"last_reconcile_error","");lastReconcileError="";}
    }catch(error){
      // Reconciliation is read-only at the exchange. A temporary API or local
      // database failure must not permanently stop an otherwise healthy bot.
      // Order submission still requires a successful reconciliation below.
      lastReconcileError=safeError(error);setSetting(db,"last_reconcile_error",lastReconcileError);
      lastReconciledAt=Date.now()-13000;
    }
  }await new Promise(r=>setTimeout(r,250));continue;}
  try{
    const equityBasis=Math.max(0,Number(setting(db,"equity_usd")||0));
    const dynamicLimits=publishLimits(equityBasis);
    validateIntent(intent,dynamicLimits);
    if(intent.actionKind==="hedge"){
      const parent=db.prepare("SELECT status FROM intents WHERE market_slug=? AND action_kind='entry' AND id<? ORDER BY id DESC LIMIT 1").get(intent.marketSlug,intent.id) as any;
      assertActionDependency(intent.actionKind,parent?.status);
    }
    const market=await exchange.market(intent);
    const availableShares=intent.side==="SELL"?await exchange.tokenShares(intent.tokenId):0;
    const adjusted=intent.side==="BUY"?{...intent,amount:effectiveBuyAmount(intent.amount,market.minimumOrderSize,intent.priceLimit,dynamicLimits.maxOrderUsd)}:{...intent,amount:executableSellShares(intent.actionKind,intent.amount,availableShares)};
    const size=adjusted.side==="BUY"?adjusted.amount/adjusted.priceLimit:adjusted.amount;
    if(!meetsMinimumShares(size,market.minimumOrderSize))throw new Error(`below market minimum order size ${market.minimumOrderSize}`);
    const collateral=await exchange.collateralUsd(),shares=availableShares;
    await reconcile();const liveExposure=Number(setting(db,"open_exposure_usd")||0);
    if(adjusted.side==="SELL"&&shares<adjusted.amount)throw new Error("insufficient outcome shares");
    assertRiskBudget({intent:adjusted,limits:dynamicLimits,openExposureUsd:liveExposure,dailyPnlUsd:Number(setting(db,"daily_pnl_usd")||0),collateralUsd:collateral});
    validateIntent(adjusted,dynamicLimits);
    transition(db,intent.id,"queued","submitting");
    let response:any;
    try{response=await exchange.place(adjusted);}catch(error){
      if(knownRejection(error)){transition(db,intent.id,"submitting","rejected",safeError(error));continue;}
      uncertain=true; transition(db,intent.id,"submitting","unknown",safeError(error));
      fs.writeFileSync(KILL_FILE,"Order outcome uncertain; reconcile manually before restart.\n",{mode:0o640}); break;
    }
    if(!response.ok){transition(db,intent.id,"submitting","rejected",`${response.code}: ${response.message}`);continue;}
    recordAcceptedFill(db,adjusted,response);
    db.prepare("INSERT INTO exchange_orders(order_id,intent_id,status,raw_json,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,raw_json=excluded.raw_json,observed_at=excluded.observed_at").run(response.orderId,intent.id,response.status,JSON.stringify(response),new Date().toISOString());
    const acceptedAfter=Number((db.prepare("SELECT COUNT(*) n FROM intents WHERE status='accepted'").get() as any).n);
    if(maxAcceptedOrders>0&&acceptedAfter>=maxAcceptedOrders)fs.writeFileSync(KILL_FILE,"Accepted-order limit reached.\n",{mode:0o640});
  }catch(error){
    const status=String((db.prepare("SELECT status FROM intents WHERE id=?").get(intent.id) as any)?.status||"");
    if(status==="queued")transition(db,intent.id,"queued","rejected",safeError(error));
    else if(status==="submitting"){transition(db,intent.id,"submitting","unknown",safeError(error));fs.writeFileSync(KILL_FILE,"Order outcome uncertain; reconcile manually before restart.\n",{mode:0o640});uncertain=true;break;}
    else {fs.writeFileSync(KILL_FILE,"Post-submission state persistence failed; review required.\n",{mode:0o640});break;}
  }
}
if(uncertain) console.error("Execution halted: unknown order outcome");
await exchange.close(); db.close();
