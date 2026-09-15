import {migrate,openDb} from "../lib/db.ts";
import {completeSetPolicy,currentCryptoMarketSlugs,simulateCompleteSet} from "../lib/complete-set.ts";
import {applyMarketFrame,marketFrameTimestamp,parseMarketFrames,type RawMarketFrame,type StreamBook} from "../lib/market-stream.ts";
import {fetchEventBySlug,summarizeBook} from "../lib/polymarket.ts";
import {simulateBuy} from "../lib/execution.ts";
import {decideInsurance,decideLeaderAdd,hedgedAccumulatorPolicy,type ProbabilityPoint} from "../lib/hedged-strategy.ts";

if((process.env.TRADING_MODE||"paper")!=="paper")throw new Error("Safety lock: TRADING_MODE must equal paper");
const WS_URL=process.env.POLYMARKET_MARKET_WS||"wss://ws-subscriptions-clob.polymarket.com/ws/market";
const completeSetEnabled=(process.env.COMPLETE_SET_ENABLED||"true").toLowerCase()!=="false";
const now=()=>new Date().toISOString(),delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type MarketSpec={slug:string;market:string;asset:"BTC"|"ETH";minutes:5|15;start:number;end:number;upTokenId:string;downTokenId:string};

migrate();
let running=true,socket:WebSocket|null=null,connectedAt:string|null=null,lastMessageAt:string|null=null,lastMessageMs=0;
const initialState=(()=>{const db=openDb();try{return db.prepare("SELECT messages,reconnects FROM v5_stream_state WHERE id=1").get() as {messages:number;reconnects:number}|undefined}finally{db.close()}})();
let messages=Number(initialState?.messages||0),reconnects=Number(initialState?.reconnects||0),lastError:string|null=null;
const books=new Map<string,StreamBook>(),bookTimestamps=new Map<string,number>(),bookReceivedAt=new Map<string,number>(),probabilityHistory=new Map<string,ProbabilityPoint[]>(),markets=new Map<string,MarketSpec>(),tokenToSlug=new Map<string,string>(),evaluationTimers=new Map<string,ReturnType<typeof setTimeout>>();

process.on("SIGINT",()=>{running=false;socket?.close(1000,"paper operator stopped")});
process.on("SIGTERM",()=>{running=false;socket?.close(1000,"paper operator stopped")});

function persistStreamState(status:string){
  const db=openDb();try{db.prepare(`INSERT INTO v5_stream_state(id,status,transport,connected_at,last_message_at,messages,reconnects,subscribed_tokens,last_error,updated_at) VALUES(1,?,'websocket',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,transport='websocket',connected_at=excluded.connected_at,last_message_at=excluded.last_message_at,messages=excluded.messages,reconnects=excluded.reconnects,subscribed_tokens=excluded.subscribed_tokens,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(status,connectedAt,lastMessageAt,messages,reconnects,tokenToSlug.size,lastError,now())}finally{db.close()}
}

async function discoverMarkets(){
  const requested=currentCryptoMarketSlugs(Math.floor(Date.now()/1000));
  const found=await Promise.all(requested.map(async spec=>{
    try{
      const event=await fetchEventBySlug(spec.slug),market=event.markets?.[0];if(!market||event.closed||market.closed)return null;
      const outcomes=JSON.parse(market.outcomes||"[]") as string[],tokens=JSON.parse(market.clobTokenIds||"[]") as string[];
      const upIndex=outcomes.findIndex(value=>/^(up|yes)$/i.test(value)),downIndex=outcomes.findIndex(value=>/^(down|no)$/i.test(value));
      if(upIndex<0||downIndex<0||!tokens[upIndex]||!tokens[downIndex])throw new Error("market did not expose Up and Down tokens");
      return {slug:spec.slug,market:event.title||spec.slug,asset:spec.asset,minutes:spec.minutes,start:spec.start,end:spec.start+spec.minutes*60,upTokenId:tokens[upIndex],downTokenId:tokens[downIndex]} satisfies MarketSpec;
    }catch(error){console.warn(`${spec.slug}: discovery unavailable: ${error instanceof Error?error.message:String(error)}`);return null}
  }));
  return found.filter((value):value is MarketSpec=>value!==null);
}

function allTokens(source=markets){return new Set([...source.values()].flatMap(spec=>[spec.upTokenId,spec.downTokenId]))}

async function refreshSubscriptions(ws:WebSocket,initial=false){
  const discovered=await discoverMarkets(),next=new Map<string,MarketSpec>();
  for(const target of currentCryptoMarketSlugs(Math.floor(Date.now()/1000))){
    const fresh=discovered.find(spec=>spec.slug===target.slug),previous=[...markets.values()].find(spec=>spec.asset===target.asset&&spec.minutes===target.minutes);
    if(fresh)next.set(fresh.slug,fresh);else if(previous)next.set(previous.slug,previous);
  }
  if(!next.size)throw new Error("No current BTC/ETH 5m/15m markets were discoverable");
  const oldTokens=allTokens(),nextTokens=allTokens(next),added=[...nextTokens].filter(token=>!oldTokens.has(token)),removed=[...oldTokens].filter(token=>!nextTokens.has(token));
  markets.clear();tokenToSlug.clear();
  for(const [slug,spec] of next){markets.set(slug,spec);tokenToSlug.set(spec.upTokenId,slug);tokenToSlug.set(spec.downTokenId,slug)}
  for(const token of removed){books.delete(token);bookTimestamps.delete(token);bookReceivedAt.delete(token);probabilityHistory.delete(token)}
  const db=openDb();try{const statement=db.prepare(`INSERT INTO ha_markets(market_slug,market,asset,minutes,start_ts,end_ts,up_token_id,down_token_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(market_slug) DO UPDATE SET market=excluded.market,up_token_id=excluded.up_token_id,down_token_id=excluded.down_token_id,status=CASE WHEN ha_markets.status='resolved' THEN 'resolved' ELSE 'active' END,updated_at=excluded.updated_at`),stamp=now();for(const spec of next.values())statement.run(spec.slug,spec.market,spec.asset,spec.minutes,spec.start,spec.end,spec.upTokenId,spec.downTokenId,stamp,stamp)}finally{db.close()}
  if(initial)ws.send(JSON.stringify({assets_ids:[...nextTokens],type:"market",custom_feature_enabled:true}));
  else{
    if(added.length)ws.send(JSON.stringify({assets_ids:added,operation:"subscribe"}));
    if(removed.length)ws.send(JSON.stringify({assets_ids:removed,operation:"unsubscribe"}));
  }
  if(added.length||removed.length||initial)console.log(`WebSocket subscriptions: ${nextTokens.size} tokens (${added.length} added, ${removed.length} removed).`);
}

function initializeHedgedAccount(){
  const db=openDb();try{
    db.prepare("INSERT OR IGNORE INTO ha_account(id,starting_balance,strategy,created_at) VALUES(1,1000,'Hedged Momentum Accumulator · BTC/ETH 5m/15m',?)").run(now());
    if(!db.prepare("SELECT id FROM ha_rule_sets LIMIT 1").get())db.prepare("INSERT INTO ha_rule_sets(version,active,rules_json,reason,created_at) VALUES(1,1,?,?,?)").run(JSON.stringify(hedgedAccumulatorPolicy),"Separate paper-only strategy based on small cheap-side insurance and progressively larger confirmed-leader additions; 20 archived completed positions reviewed (12 profitable, 8 losing, +$83.86 aggregate) and large paired-leg losses motivated a $60 market cap and 5% account drawdown stop",now());
  }finally{db.close()}
}

function hedgedAccountValues(db:ReturnType<typeof openDb>){
  const starting=(db.prepare("SELECT starting_balance FROM ha_account WHERE id=1").get() as {starting_balance:number}).starting_balance,rows=db.prepare("SELECT * FROM ha_positions").all() as any[];
  const realized=rows.reduce((sum,row)=>sum+Number(row.realized_pnl||0),0),deployed=rows.filter(row=>row.status==="open").reduce((sum,row)=>sum+Number(row.cost_basis||0),0),unrealized=rows.filter(row=>row.status==="open").reduce((sum,row)=>sum+Number(row.shares)*Number(row.current_price)-Number(row.cost_basis),0);
  return {starting,realized,deployed,unrealized,equity:starting+realized+unrealized,available:starting+realized-deployed};
}

function snapshotHedgedAccount(db=openDb()){
  const ownsDb=arguments.length===0;try{const value=hedgedAccountValues(db);db.prepare("INSERT INTO ha_snapshots(equity,available_cash,deployed,realized_pnl,unrealized_pnl,captured_at) VALUES(?,?,?,?,?,?)").run(value.equity,value.available,value.deployed,value.realized,value.unrealized,now());return value}finally{if(ownsDb)db.close()}
}

function executeHedgedBuy(db:ReturnType<typeof openDb>,spec:MarketSpec,input:{phase:"insurance"|"leader_add";tier?:string;side:"Up"|"Down";probability:number;dollars:number;reason:string},upBook:StreamBook,downBook:StreamBook){
  const eventKey=`${input.phase}:${input.tier||"base"}:${spec.slug}`;if(db.prepare("SELECT id FROM ha_events WHERE event_key=?").get(eventKey))return;
  const account=hedgedAccountValues(db);if(account.available<5)return;
  const marketSpend=(db.prepare("SELECT COALESCE(SUM(cost_basis),0) dollars FROM ha_positions WHERE market_slug=? AND status='open'").get(spec.slug) as {dollars:number}).dollars,requested=Math.min(input.dollars,account.available,60-marketSpend);if(requested<5)return;
  const token=input.side==="Up"?spec.upTokenId:spec.downTokenId,book=input.side==="Up"?upBook:downBook,fill=simulateBuy(book,requested);if(fill.spent<5||fill.fillRatio<.90)return;
  const stamp=now();db.prepare("INSERT INTO ha_events(event_key,market_slug,market,phase,tier,token_id,outcome,probability,requested_dollars,filled_dollars,shares,avg_price,fee_usdc,fill_ratio,decision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'paper_buy',?,?)").run(eventKey,spec.slug,spec.market,input.phase,input.tier||null,token,input.side,input.probability,requested,fill.spent,fill.shares,fill.avgPrice,fill.fee,fill.fillRatio,input.reason,stamp);
  db.prepare(`INSERT INTO ha_positions(token_id,market_slug,market,outcome,shares,cost_basis,current_price,realized_pnl,status,opened_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'open',?,?) ON CONFLICT(token_id) DO UPDATE SET shares=shares+excluded.shares,cost_basis=cost_basis+excluded.cost_basis,current_price=excluded.current_price,status='open',closed_at=NULL,updated_at=excluded.updated_at`).run(token,spec.slug,spec.market,input.side,fill.shares,fill.spent,fill.avgPrice,stamp,stamp);
  snapshotHedgedAccount(db);console.log(`${spec.slug}: hedged ${input.phase} ${input.side}, $${fill.spent.toFixed(2)} paper fill at ${(fill.avgPrice*100).toFixed(1)}¢`);
}

function evaluateHedgedMarket(spec:MarketSpec){
  const unixNow=Date.now()/1000;if(unixNow>spec.end+5)return;
  const upBook=books.get(spec.upTokenId),downBook=books.get(spec.downTokenId);if(!upBook||!downBook)return;
  const up=summarizeBook(upBook),down=summarizeBook(downBook);if(up.bid<=0||up.ask>=1||down.bid<=0||down.ask>=1)return;
  const upProbability=(up.bid+up.ask)/2,downProbability=(down.bid+down.ask)/2,elapsedFraction=Math.max(0,Math.min(1,(unixNow-spec.start)/(spec.end-spec.start))),secondsRemaining=Math.max(0,spec.end-unixNow),db=openDb();
  try{
    db.prepare("UPDATE ha_positions SET current_price=?,updated_at=? WHERE token_id=? AND status='open'").run(up.bid,now(),spec.upTokenId);db.prepare("UPDATE ha_positions SET current_price=?,updated_at=? WHERE token_id=? AND status='open'").run(down.bid,now(),spec.downTokenId);
    const insurance=db.prepare("SELECT id FROM ha_events WHERE market_slug=? AND phase='insurance' AND decision='paper_buy'").get(spec.slug);
    if(!insurance){const decision=decideInsurance({elapsedFraction,secondsRemaining,upProbability,downProbability,upAsk:up.ask,downAsk:down.ask,upSpread:up.spread,downSpread:down.spread});if(decision.action==="buy_insurance")executeHedgedBuy(db,spec,{phase:"insurance",side:decision.side,probability:decision.probability,dollars:decision.dollars,reason:decision.reason},upBook,downBook);return}
    const executed=(db.prepare("SELECT tier FROM ha_events WHERE market_slug=? AND phase='leader_add' AND decision='paper_buy'").all(spec.slug) as {tier:string}[]).map(row=>row.tier),currentMarketDollars=(db.prepare("SELECT COALESCE(SUM(cost_basis),0) dollars FROM ha_positions WHERE market_slug=? AND status='open'").get(spec.slug) as {dollars:number}).dollars;
    const decision=decideLeaderAdd({now:Date.now(),secondsRemaining,upProbability,downProbability,upHistory:probabilityHistory.get(spec.upTokenId)||[],downHistory:probabilityHistory.get(spec.downTokenId)||[],executedTiers:executed,currentMarketDollars});
    if(decision.action==="buy_leader")executeHedgedBuy(db,spec,{phase:"leader_add",tier:decision.tier,side:decision.side,probability:decision.probability,dollars:decision.dollars,reason:decision.reason},upBook,downBook);
  }finally{db.close()}
}

async function settleHedgedPositions(){
  const db=openDb();try{
    const expired=db.prepare("SELECT * FROM ha_markets WHERE status='active' AND end_ts<?").all(Math.floor(Date.now()/1000)-5) as any[];
    for(const spec of expired){
      try{const event=await fetchEventBySlug(spec.market_slug),market=event.markets?.[0];if(!event.closed||!market?.closed)continue;const tokens=JSON.parse(market.clobTokenIds||"[]") as string[],prices=JSON.parse(market.outcomePrices||"[]") as string[];
        for(const position of db.prepare("SELECT * FROM ha_positions WHERE market_slug=? AND status='open'").all(spec.market_slug) as any[]){const index=tokens.indexOf(String(position.token_id)),finalPrice=Number(prices[index]);if(index<0||(finalPrice!==0&&finalPrice!==1))continue;const pnl=Number(position.shares)*finalPrice-Number(position.cost_basis);db.prepare("UPDATE ha_positions SET shares=0,cost_basis=0,current_price=?,realized_pnl=realized_pnl+?,status=?,updated_at=?,closed_at=? WHERE token_id=?").run(finalPrice,pnl,finalPrice===1?"won":"lost",now(),now(),position.token_id)}
        db.prepare("UPDATE ha_markets SET status='resolved',updated_at=? WHERE market_slug=?").run(now(),spec.market_slug);snapshotHedgedAccount(db);
      }catch(error){console.warn(`${spec.market_slug}: hedged settlement unavailable: ${error instanceof Error?error.message:String(error)}`)}
    }
  }finally{db.close()}
}

function snapshotAccount(db:ReturnType<typeof openDb>){
  const starting=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}).starting_balance;
  const realized=(db.prepare("SELECT COALESCE(SUM(locked_profit),0) pnl FROM v5_opportunities WHERE decision='paper_complete_set'").get() as {pnl:number}).pnl;
  db.prepare("INSERT INTO account_snapshots(equity,available_cash,deployed,realized_pnl,unrealized_pnl,captured_at) VALUES(?,?,0,?,0,?)").run(starting+realized,starting+realized,realized,now());
}

function writeReport(){
  const db=openDb();try{
    snapshotAccount(db);
    const date=now().slice(0,10),account=db.prepare("SELECT starting_balance,strategy FROM paper_accounts WHERE id=1").get() as {starting_balance:number;strategy:string};
    const totals=db.prepare("SELECT COUNT(*) scans,SUM(decision='paper_complete_set') fills,COALESCE(SUM(locked_profit),0) profit FROM v5_opportunities").get() as {scans:number;fills:number;profit:number};
    const equity=account.starting_balance+Number(totals.profit||0),summary=`${account.strategy} paper report ${date}\nPaper funding basis: $${account.starting_balance.toFixed(2)}\nPaper equity: $${equity.toFixed(2)}\nLifetime paper PnL: $${Number(totals.profit||0).toFixed(2)}\nAvailable cash: $${equity.toFixed(2)}\nData transport: WebSocket (${socket?.readyState===WebSocket.OPEN?"connected":"disconnected"})\nMarket-stream messages: ${messages}\nSubscribed outcome tokens: ${tokenToSlug.size}\nComplete-set markets observed: ${Number(totals.scans||0)}\nFee-and-buffer-qualified fills: ${Number(totals.fills||0)}\nSafety: no real trades were placed.`;
    db.prepare("INSERT INTO reports(report_date,summary,sent_to_telegram,created_at) VALUES(?,?,0,?) ON CONFLICT(report_date) DO UPDATE SET summary=excluded.summary,sent_to_telegram=0,created_at=excluded.created_at").run(date,summary,now());
    const hedged=hedgedAccountValues(db),events=db.prepare("SELECT COUNT(*) n FROM ha_events WHERE decision='paper_buy'").get() as {n:number},positions=db.prepare("SELECT COUNT(*) n FROM ha_positions WHERE status='open'").get() as {n:number};
    const hedgedSummary=`Hedged Momentum Accumulator paper report ${date}\nPaper funding basis: $${hedged.starting.toFixed(2)}\nPaper equity: $${hedged.equity.toFixed(2)}\nAvailable cash: $${hedged.available.toFixed(2)}\nRealized PnL: $${hedged.realized.toFixed(2)}\nUnrealized PnL: $${hedged.unrealized.toFixed(2)}\nPaper buys: ${events.n}\nOpen positions: ${positions.n}\nData transport: shared public WebSocket\nSafety: no real trades were placed.`;
    db.prepare("INSERT INTO ha_reports(report_date,summary,created_at) VALUES(?,?,?) ON CONFLICT(report_date) DO UPDATE SET summary=excluded.summary,created_at=excluded.created_at").run(date,hedgedSummary,now());
  }finally{db.close()}
}

function evaluateMarket(spec:MarketSpec){
  if(Date.now()/1000>spec.end+5)return;
  const upBook=books.get(spec.upTokenId),downBook=books.get(spec.downTokenId);if(!upBook||!downBook)return;
  const db=openDb();try{
    const existing=db.prepare("SELECT decision FROM v5_opportunities WHERE market_slug=?").get(spec.slug) as {decision:string}|undefined;if(existing?.decision==="paper_complete_set")return;
    const account=db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number};
    const realized=(db.prepare("SELECT COALESCE(SUM(locked_profit),0) pnl FROM v5_opportunities WHERE decision='paper_complete_set'").get() as {pnl:number}).pnl;
    const result=simulateCompleteSet(upBook,downBook,Math.min(completeSetPolicy.maxDollarsPerMarket,account.starting_balance+realized)),up=summarizeBook(upBook),down=summarizeBook(downBook),stamp=now(),filled=result.decision==="paper_complete_set";
    const sourceTimestamp=Math.max(bookTimestamps.get(spec.upTokenId)||0,bookTimestamps.get(spec.downTokenId)||0)||null,receivedAt=Math.max(bookReceivedAt.get(spec.upTokenId)||0,bookReceivedAt.get(spec.downTokenId)||0)||null,latency=receivedAt==null?null:Math.max(0,Date.now()-receivedAt);
    db.prepare(`INSERT INTO v5_opportunities(market_slug,market,asset,minutes,up_token_id,down_token_id,up_ask,down_ask,raw_ask_sum,pairs,gross_cost,fee_usdc,execution_reserve,conservative_cost,locked_profit,net_edge_per_pair,decision,reason,first_seen_at,updated_at,filled_at,transport,source_timestamp_ms,evaluation_latency_ms,book_updates) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'websocket',?,?,1) ON CONFLICT(market_slug) DO UPDATE SET up_ask=excluded.up_ask,down_ask=excluded.down_ask,raw_ask_sum=excluded.raw_ask_sum,pairs=excluded.pairs,gross_cost=excluded.gross_cost,fee_usdc=excluded.fee_usdc,execution_reserve=excluded.execution_reserve,conservative_cost=excluded.conservative_cost,locked_profit=excluded.locked_profit,net_edge_per_pair=excluded.net_edge_per_pair,decision=excluded.decision,reason=excluded.reason,updated_at=excluded.updated_at,filled_at=excluded.filled_at,transport='websocket',source_timestamp_ms=excluded.source_timestamp_ms,evaluation_latency_ms=excluded.evaluation_latency_ms,book_updates=book_updates+1`).run(spec.slug,spec.market,spec.asset,spec.minutes,spec.upTokenId,spec.downTokenId,up.ask,down.ask,up.ask+down.ask,result.pairs,result.gross,result.fees,result.buffer,result.conservativeCost,result.lockedProfit,result.netEdgePerPair,result.decision,result.reason,stamp,stamp,filled?stamp:null,sourceTimestamp,latency);
    db.prepare("INSERT INTO v5_daily_stats(report_date,scans,opportunities,fills,locked_profit,updated_at) VALUES(?,1,1,?,?,?) ON CONFLICT(report_date) DO UPDATE SET scans=scans+1,opportunities=opportunities+1,fills=fills+excluded.fills,locked_profit=locked_profit+excluded.locked_profit,updated_at=excluded.updated_at").run(stamp.slice(0,10),filled?1:0,filled?result.lockedProfit:0,stamp);
    if(filled){snapshotAccount(db);console.log(`${spec.slug}: WebSocket paper complete set ${result.pairs.toFixed(2)} pairs, locked $${result.lockedProfit.toFixed(2)}`)}
  }finally{db.close()}
}

function scheduleEvaluation(slug:string){
  const previous=evaluationTimers.get(slug);if(previous)clearTimeout(previous);
  evaluationTimers.set(slug,setTimeout(()=>{evaluationTimers.delete(slug);const spec=markets.get(slug);if(spec){if(completeSetEnabled)evaluateMarket(spec);evaluateHedgedMarket(spec)}},50));
}

function processFrame(frame:RawMarketFrame){
  const timestamp=marketFrameTimestamp(frame),changed=applyMarketFrame(books,frame);
  for(const token of changed){if(timestamp!=null)bookTimestamps.set(token,timestamp);const received=Date.now();bookReceivedAt.set(token,received);const book=books.get(token);if(book){const summary=summarizeBook(book);if(summary.bid>0&&summary.ask<1){const history=[...(probabilityHistory.get(token)||[]),{at:received,probability:(summary.bid+summary.ask)/2}].filter(point=>point.at>=received-15_000);probabilityHistory.set(token,history)}}const slug=tokenToSlug.get(token);if(slug)scheduleEvaluation(slug)}
}

async function runConnection(){
  const initialMarkets=await discoverMarkets();if(!initialMarkets.length)throw new Error("No current markets available for WebSocket subscription");
  markets.clear();for(const spec of initialMarkets)markets.set(spec.slug,spec);
  return new Promise<void>((resolve,reject)=>{
    const ws=new WebSocket(WS_URL);socket=ws;let heartbeat:ReturnType<typeof setInterval>|null=null,discovery:ReturnType<typeof setInterval>|null=null,stateTimer:ReturnType<typeof setInterval>|null=null,reportTimer:ReturnType<typeof setInterval>|null=null,refreshing=false,settled=false,stateTicks=0;
    const cleanup=()=>{for(const timer of [heartbeat,discovery,stateTimer,reportTimer])if(timer)clearInterval(timer)};
    const finish=(error?:Error)=>{if(settled)return;settled=true;cleanup();socket=null;error?reject(error):resolve()};
    ws.addEventListener("open",async()=>{
      try{
        await refreshSubscriptions(ws,true);connectedAt=now();lastMessageAt=connectedAt;lastMessageMs=Date.now();lastError=null;persistStreamState("connected");writeReport();
        heartbeat=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN)return;if(Date.now()-lastMessageMs>35_000){ws.close(4000,"market stream stale");return}ws.send("PING")},10_000);
        void settleHedgedPositions();
        discovery=setInterval(async()=>{if(refreshing||ws.readyState!==WebSocket.OPEN)return;refreshing=true;try{await refreshSubscriptions(ws);await settleHedgedPositions()}catch(error){console.warn(`Subscription refresh failed: ${error instanceof Error?error.message:String(error)}`)}finally{refreshing=false}},15_000);
        stateTimer=setInterval(()=>{persistStreamState("connected");if(++stateTicks%10===0)snapshotHedgedAccount()},1_000);reportTimer=setInterval(writeReport,60_000);
      }catch(error){ws.close(4001,"subscription failed");finish(error instanceof Error?error:new Error(String(error)))}
    });
    ws.addEventListener("message",event=>{
      lastMessageMs=Date.now();lastMessageAt=now();messages++;
      const raw=String(event.data);if(raw==="PONG")return;
      try{for(const frame of parseMarketFrames(raw))processFrame(frame)}catch(error){console.warn(`Ignored malformed market-stream frame: ${error instanceof Error?error.message:String(error)}`)}
    });
    ws.addEventListener("error",()=>{lastError="Market WebSocket connection error"});
    ws.addEventListener("close",event=>finish(new Error(`Market WebSocket closed (${event.code}${event.reason?`: ${event.reason}`:""})`)));
  });
}

let backoff=1_000;
initializeHedgedAccount();snapshotHedgedAccount();
while(running){
  try{await runConnection();backoff=1_000}catch(error){if(!running)break;reconnects++;lastError=error instanceof Error?error.message:String(error);persistStreamState("reconnecting");console.warn(`${lastError}; reconnecting in ${(backoff/1000).toFixed(0)}s`);await delay(backoff);backoff=Math.min(30_000,backoff*2)}
}
persistStreamState("stopped");writeReport();console.log("Crypto Execution Lab v5 WebSocket stream stopped.");
