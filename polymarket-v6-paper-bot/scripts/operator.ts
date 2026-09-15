import { migrate, openDb } from "../lib/db.ts";
import { defaultRules, paperPnl, scoreTrade, scoreWallet } from "../lib/scoring.ts";
import { conservativeMirrorPolicy, sizeConservativeBuy, sizeProfileMirrorBuy } from "../lib/risk.ts";
import { simulateBuy, simulateSell } from "../lib/execution.ts";
import { executablePositionMark, fetchActivity, fetchBook, fetchClosedPositions, fetchEventBySlug, fetchLeaderboard, fetchPortfolioValue, fetchPositions, isBtc5mMarket, isSupportedShortCryptoMarket, parseShortCryptoMarket, summarizeBook } from "../lib/polymarket.ts";
import { decideFinalMinuteProbability, finalMinuteProbabilityPolicy } from "../lib/final-minute.ts";
import { copyActivityCutoff, normalizeCopyProfile, selectMonitorWallets } from "../lib/profile-selection.ts";
import { completeSetPolicy, currentCryptoMarketSlugs, simulateCompleteSet } from "../lib/complete-set.ts";
import type { Rules, WalletInput } from "../lib/types.ts";
import fs from "node:fs";
import path from "node:path";

if ((process.env.TRADING_MODE || "paper") !== "paper") throw new Error("Safety lock: TRADING_MODE must equal paper");
const now = () => new Date().toISOString();
const marketAllowed=(item:{slug?:string;eventSlug?:string;title?:string})=>(process.env.MARKET_MODE==="btc5"?isBtc5mMarket(item):isSupportedShortCryptoMarket(item));

function activeRules(db: ReturnType<typeof openDb>): Rules {
  const row = db.prepare("SELECT rules_json FROM rule_sets WHERE active=1 ORDER BY version DESC LIMIT 1").get() as { rules_json: string } | undefined;
  return row ? JSON.parse(row.rules_json) : defaultRules;
}

function saveWallet(db: ReturnType<typeof openDb>, w: WalletInput) {
  const s = scoreWallet(w, activeRules(db));
  db.prepare(`INSERT INTO wallets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET label=excluded.label, category=excluded.category, pnl=excluded.pnl,
    volume=excluded.volume, trades=excluded.trades, resolved_trades=excluded.resolved_trades, wins=excluded.wins,
    largest_trade_pnl=excluded.largest_trade_pnl, average_liquidity=excluded.average_liquidity,
    average_spread=excluded.average_spread, average_price_move=excluded.average_price_move,
    roi_score=excluded.roi_score, consistency_score=excluded.consistency_score,
    copyability_score=excluded.copyability_score, one_hit_penalty=excluded.one_hit_penalty,
    global_score=excluded.global_score, status=excluded.status, reason=excluded.reason, updated_at=excluded.updated_at`)
    .run(w.address, w.label || null, w.category, w.pnl, w.volume, w.trades, w.resolvedTrades, w.wins,
      w.largestTradePnl, w.averageLiquidity, w.averageSpread, w.averagePriceMove,
      s.roi, s.consistency, s.copyability, s.oneHitPenalty, s.global, s.status, s.reason, now());
}

function seed() {
  migrate(); const db = openDb();
  db.prepare("INSERT OR REPLACE INTO paper_accounts(id,starting_balance,strategy,created_at) VALUES(1,1000,'BTC Up or Down - 5 minute only',?)").run(now());
  if (!(db.prepare("SELECT id FROM rule_sets LIMIT 1").get())) db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(1,1,?,?,?)").run(JSON.stringify(defaultRules), "Safe starter thresholds", now());
  db.exec("DELETE FROM pnl_snapshots; DELETE FROM paper_trades; DELETE FROM signals; DELETE FROM wallets;");
  const wallets: WalletInput[] = [
    { address: "demo-btc5m-steady", label: "DEMO · FiveMinuteEdge", pnl: 184, volume: 1240, trades: 48, resolvedTrades: 31, wins: 22, largestTradePnl: 31, averageLiquidity: 24000, averageSpread: .018, averagePriceMove: .025, category: "BTC 5m" },
    { address: "demo-btc5m-watch", label: "DEMO · QuickMacro", pnl: 96, volume: 910, trades: 27, resolvedTrades: 18, wins: 12, largestTradePnl: 25, averageLiquidity: 16000, averageSpread: .026, averagePriceMove: .04, category: "BTC 5m" },
    { address: "demo-btc5m-lucky", label: "DEMO · OneBigHit", pnl: 290, volume: 760, trades: 11, resolvedTrades: 7, wins: 3, largestTradePnl: 265, averageLiquidity: 3200, averageSpread: .085, averagePriceMove: .11, category: "BTC 5m" }
  ];
  wallets.forEach(w => saveWallet(db, w));
  const signal = db.prepare("INSERT OR IGNORE INTO signals(wallet,market,category,side,token_id,market_slug,outcome,wallet_entry,current_price,spread,liquidity,score,decision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  signal.run(wallets[0].address, "DEMO · Bitcoin Up or Down - 5:00-5:05 PM", "BTC 5m", "BUY", "demo-btc-5m-up", "demo-btc-5m-a", "Up", .48, .52, .018, 24000, 81, "paper_copy", "Strong BTC-5m wallet, liquid book, small delay", now());
  signal.run(wallets[1].address, "DEMO · Bitcoin Up or Down - 5:05-5:10 PM", "BTC 5m", "BUY", "demo-btc-5m-down", "demo-btc-5m-b", "Down", .61, .63, .026, 16000, 68, "paper_copy", "Meets all BTC-5m paper thresholds", now());
  signal.run(wallets[2].address, "DEMO · Bitcoin Up or Down - 5:10-5:15 PM", "BTC 5m", "BUY", "demo-btc-5m-skip", "demo-btc-5m-c", "Up", .32, .44, .085, 3200, 29, "skip", "Wide spread, low liquidity, and late entry", now());
  const rows = db.prepare("SELECT id,current_price,score,decision FROM signals WHERE decision='paper_copy'").all() as { id:number; current_price:number; score:number; decision:string }[];
  for (const row of rows) {
    const size = scoreTrade({ walletGlobal: row.score, walletCategory: row.score, walletEntry: row.current_price, currentPrice: row.current_price, spread: .02, liquidity: 20000, hoursToResolution: 5 / 60 }).size || 10;
    db.prepare("INSERT OR IGNORE INTO paper_trades(signal_id,entry_price,current_price,size,pnl,status,opened_at) VALUES(?,?,?,?,0,'open',?)").run(row.id, row.current_price, row.current_price, size, now());
  }
  db.close(); console.log("Seeded clearly labeled demo research data.");
}

async function leaderboard() {
  migrate(); const leaders = await fetchLeaderboard(Number(process.env.LEADERBOARD_LIMIT || 100)); const db = openDb();
  for (const [index, leader] of leaders.entries()) {
    const address = leader.proxyWallet || leader.userAddress; if (!address) continue;
    const closed = (await fetchClosedPositions(address)).filter(marketAllowed);
    if (!closed.length) { console.log(`[${index + 1}/${leaders.length}] ${address} (no supported short-crypto realized-profit evidence)`); continue; }
    const profits = closed.map(p => Number(p.realizedPnl || 0)).filter(value => value > 0);
    const pnl = profits.reduce((sum, value) => sum + value, 0);
    const volume = closed.reduce((sum, p) => sum + Number(p.totalBought || 0), 0);
    const largest = Math.max(0, ...profits);
    const evidence = Math.min(100, closed.length / 30 * 100);
    const input: WalletInput = { address, label: leader.userName || leader.name, pnl, volume, trades: closed.length, resolvedTrades: closed.length, wins: 0, largestTradePnl: largest, consistencyEvidence: evidence,
      averageLiquidity: 12000, averageSpread: .035, averagePriceMove: .04, category: "Short crypto" };
    saveWallet(db, input); console.log(`[${index + 1}/${leaders.length}] ${address} (${closed.length} profitable BTC-5m closures, $${pnl.toFixed(2)} realized-profit evidence)`);
  }
  db.close();
}

async function monitor() {
  migrate(); const db = openDb(); const rules = activeRules(db);
  const bookCache=new Map<string,Awaited<ReturnType<typeof fetchBook>>>();
  const cachedBook=async(tokenId:string)=>{let book=bookCache.get(tokenId);if(!book){book=await fetchBook(tokenId);bookCache.set(tokenId,book)}return book};
  const rankedWallets = db.prepare("SELECT address,global_score,category FROM wallets WHERE status='track' AND address LIKE '0x%' ORDER BY global_score DESC, resolved_trades DESC LIMIT ?").all(conservativeMirrorPolicy.maxProfiles) as {address:string;global_score:number;category:string}[];
  const wallets=selectMonitorWallets(process.env.COPY_PROFILE,rankedWallets);
  const paperFund=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}).starting_balance;
  const profileValue=process.env.COPY_PROFILE?await fetchPortfolioValue(wallets[0].address):paperFund;
  const sizingMode=String((rules as Rules&Record<string,unknown>).profileSizing||"");
  const exactMode=sizingMode.startsWith("dollar-for-dollar")||sizingMode==="exact-source-dollars"||sizingMode==="exact-source-shadow-ledger",copyRatio=exactMode?1:paperFund/profileValue;
  const sourcePositions=new Map((process.env.COPY_PROFILE?await fetchPositions(wallets[0].address):[]).map(position=>[String(position.asset),position]));
  db.prepare("INSERT INTO mirror_state(id,profile_value,copy_ratio,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_value=excluded.profile_value,copy_ratio=excluded.copy_ratio,updated_at=excluded.updated_at").run(profileValue,copyRatio,now());
  const unixNow = Math.floor(Date.now() / 1000);
  const accountCreated=(db.prepare("SELECT created_at FROM paper_accounts WHERE id=1").get() as {created_at:string}|undefined)?.created_at;
  const accountCreatedUnix=accountCreated?Math.floor(new Date(accountCreated).getTime()/1000):unixNow;
  const recentCutoff=process.env.COPY_PROFILE?copyActivityCutoff(unixNow,accountCreated):unixNow-3*60;
  for (const wallet of wallets) for (const a of (await fetchActivity(wallet.address, 100))
    .filter(x => (x.side === "BUY" || x.side === "SELL") && x.asset && x.price && Number(x.timestamp || 0) >= recentCutoff && marketAllowed(x))
    .sort((left,right)=>Number(left.timestamp||0)-Number(right.timestamp||0))) {
    const sourceSide = a.side!;
    const spec=parseShortCryptoMarket(a); if(!spec)continue; const {slug,start}=spec,duration=spec.minutes*60;
    if(!start || unixNow < start || unixNow >= start + duration) continue;
    if(exactMode&&start<accountCreatedUnix)continue;
    const tokenId = a.asset!,sourceSize=Number(a.size||0),sourceUsdc=Number(a.usdcSize??sourceSize*Number(a.price));
    const eventKey=`${a.transactionHash||a.timestamp}:${tokenId}:${sourceSide}:${sourceSize}:${a.price}`;
    if(db.prepare("SELECT id FROM copy_events WHERE event_key=?").get(eventKey))continue;
    const sourcePrice=Number(a.price),rawBook=exactMode?{bids:[{price:String(sourcePrice),size:String(sourceSize)}],asks:[{price:String(sourcePrice),size:String(sourceSize)}],last_trade_price:String(sourcePrice)}:await cachedBook(tokenId),book = summarizeBook(rawBook);
    const executablePrice=sourceSide==="BUY"?book.ask:book.bid;
    const result = scoreTrade({ walletGlobal: wallet.global_score, walletCategory: wallet.global_score, walletEntry: Number(a.price), currentPrice: executablePrice, spread: book.spread, liquidity: book.liquidity, hoursToResolution: Math.max(0,(start+duration-unixNow)/3600) }, rules);
    const market=a.title || slug;
    const account=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}).starting_balance;
    const totals=db.prepare("SELECT COALESCE(SUM(realized_pnl),0) realized,COALESCE(SUM(CASE WHEN status='open' THEN cost_basis ELSE 0 END),0) deployed FROM paper_positions_v2").get() as {realized:number;deployed:number};
    const position=db.prepare("SELECT * FROM paper_positions_v2 WHERE token_id=?").get(tokenId) as any;
    let decision=exactMode?"paper_copy":result.decision, reason="", paperDollars=0, paperShares=0,requestedDollars=0,fillRatio=0,fee=0;
    if(sourceSide==="BUY") {
      const available=Math.max(0,account+totals.realized-totals.deployed);
      const marketExposure=(db.prepare("SELECT COALESCE(SUM(cost_basis),0) exposure FROM paper_positions_v2 WHERE status='open' AND market_slug=?").get(slug) as {exposure:number}).exposure;
      const sized=sizeProfileMirrorBuy({availableCash:available,portfolioExposure:totals.deployed,marketExposure,outcomeExposure:Number(position?.status==="open"?position.cost_basis:0),price:Number(a.price),sourceUsdc,copyRatio});
      requestedDollars=sized.dollars;
      if(exactMode&&decision==="paper_copy"&&sized.dollars===sourceUsdc&&sourceSize>0){paperDollars=sourceUsdc;paperShares=sourceSize;fillRatio=1;reason="Exact source-reported dollars and shares; shadow fill with no independent book execution";}
      else if(exactMode){decision="skip";reason=sized.dollars<=0?sized.reason:"Insufficient paper cash for an exact source fill; no partial copy was made";}
      else if(decision==="paper_copy" && sized.dollars>0) { const fill=simulateBuy(rawBook,sized.dollars);paperDollars=fill.spent;paperShares=fill.shares;fillRatio=fill.fillRatio;fee=fill.fee;reason=fill.shares>0?`${sized.reason}; depth-aware taker fill` : "No ask liquidity available";if(!fill.shares)decision="skip"; }
      else { const failedEntryFilter=decision!=="paper_copy"; decision="skip"; reason=failedEntryFilter?result.rejectionReasons.join("; ")||"Deterministic entry score rejected the buy":sized.reason; }
    } else {
      if(exactMode){const requestedShares=Math.min(Number(position?.shares||0),sourceSize);paperShares=requestedShares;paperDollars=sourceSize>0?sourceUsdc*(requestedShares/sourceSize):0;fillRatio=sourceSize?requestedShares/sourceSize:0;decision=paperShares>0?"paper_copy":"skip";reason=paperShares>0?"Exact source-reported sell reduced the shadow position":"No matching shadow shares";}
      else {
      const scale=(db.prepare("SELECT COALESCE(SUM(paper_shares)/NULLIF(SUM(source_size),0),0) scale FROM copy_events WHERE wallet=? AND token_id=? AND side='BUY' AND decision='paper_copy'").get(wallet.address,tokenId) as {scale:number}).scale;
      const requestedShares=Math.min(Number(position?.shares || 0),sourceSize*scale),fill=simulateSell(rawBook,requestedShares);paperShares=fill.shares;paperDollars=fill.proceeds;fillRatio=fill.fillRatio;fee=fill.fee;
      decision=paperShares>0?"paper_copy":"skip"; reason=paperShares>0?"Mirrored proportional sell against visible bid depth":"No matching shares or bid liquidity";
      }
    }
    const detectedAt=now(),sourceTimestamp=Number(a.timestamp||0),latencyMs=Math.max(0,Date.now()-sourceTimestamp*1000);
    db.prepare("INSERT INTO copy_events(event_key,wallet,market,market_slug,token_id,outcome,side,source_size,source_usdc,source_price,market_price,paper_dollars,paper_shares,decision,reason,created_at,source_timestamp,detected_at,latency_ms,requested_dollars,fill_ratio,fee_usdc,strategy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(eventKey,wallet.address,market,slug,tokenId,a.outcome||null,sourceSide,sourceSize,sourceUsdc,Number(a.price),sourceSide==="BUY"?(paperShares?(paperDollars-fee)/paperShares:book.price):(paperShares?(paperDollars+fee)/paperShares:book.price),paperDollars,sourceSide==="SELL"?-paperShares:paperShares,decision,reason,detectedAt,sourceTimestamp,detectedAt,latencyMs,requestedDollars,fillRatio,fee,"copy");
    if(decision!=="paper_copy") continue;
    if(sourceSide==="BUY") {
      db.prepare(`INSERT INTO paper_positions_v2(token_id,wallet,market,market_slug,outcome,shares,cost_basis,current_price,status,opened_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'open',?,?) ON CONFLICT(token_id) DO UPDATE SET shares=shares+excluded.shares,cost_basis=cost_basis+excluded.cost_basis,current_price=excluded.current_price,status='open',closed_at=NULL,updated_at=excluded.updated_at`)
        .run(tokenId,wallet.address,market,slug,a.outcome||null,paperShares,paperDollars,exactMode?Number(sourcePositions.get(tokenId)?.curPrice||Number(a.price)):executablePositionMark(rawBook),now(),now());
    } else if(position) {
      const fraction=paperShares/position.shares, removedCost=position.cost_basis*fraction, realized=paperDollars-removedCost, remaining=position.shares-paperShares;
      db.prepare("UPDATE paper_positions_v2 SET shares=?,cost_basis=?,realized_pnl=realized_pnl+?,current_price=?,status=?,updated_at=?,closed_at=? WHERE token_id=?")
        .run(remaining,position.cost_basis-removedCost,realized,executablePositionMark(rawBook),remaining<1e-9?"sold":"open",now(),remaining<1e-9?now():null,tokenId);
    }
  }
  for(const open of db.prepare("SELECT token_id FROM paper_positions_v2 WHERE status='open'").all() as {token_id:string}[]) {
    try {
      const sourcePosition=sourcePositions.get(open.token_id),mark=exactMode&&sourcePosition?Number(sourcePosition.curPrice):executablePositionMark(await cachedBook(open.token_id));
      db.prepare("UPDATE paper_positions_v2 SET current_price=?,updated_at=? WHERE token_id=?").run(mark,now(),open.token_id);
    } catch(error) {
      console.warn(`Position mark unavailable for ${open.token_id}; preserving its last mark: ${error instanceof Error?error.message:String(error)}`);
    }
  }
  snapshotAccount(db);
  db.close();
}

function snapshotAccount(db: ReturnType<typeof openDb>) {
  const starting=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}|undefined)?.starting_balance||1000;
  const rows=db.prepare("SELECT * FROM paper_positions_v2").all() as any[];
  const v5Realized=(db.prepare("SELECT COALESCE(SUM(locked_profit),0) pnl FROM v5_opportunities WHERE decision='paper_complete_set'").get() as {pnl:number}).pnl;
  const realized=rows.reduce((s,p)=>s+Number(p.realized_pnl||0),0)+v5Realized, deployed=rows.filter(p=>p.status==="open").reduce((s,p)=>s+Number(p.cost_basis||0),0);
  const unrealized=rows.filter(p=>p.status==="open").reduce((s,p)=>s+(Number(p.shares)*Number(p.current_price)-Number(p.cost_basis)),0);
  const equity=starting+realized+unrealized, available=starting+realized-deployed;
  db.prepare("INSERT INTO account_snapshots(equity,available_cash,deployed,realized_pnl,unrealized_pnl,captured_at) VALUES(?,?,?,?,?,?)").run(equity,available,deployed,realized,unrealized,now());
}

function scoreSignals() {
  migrate(); const db = openDb(); const rules = activeRules(db);
  const rows = db.prepare("SELECT s.*,w.global_score FROM signals s JOIN wallets w ON w.address=s.wallet").all() as any[];
  for (const row of rows) {
    const r = scoreTrade({walletGlobal:row.global_score,walletCategory:row.global_score,walletEntry:row.wallet_entry,currentPrice:row.current_price,spread:row.spread,liquidity:row.liquidity,hoursToResolution:5/60}, rules);
    db.prepare("UPDATE signals SET score=?,decision=? WHERE id=?").run(r.score,r.decision,row.id);
    if(r.decision!=="paper_copy") continue;
    const account=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}|undefined)?.starting_balance||1000;
    const totals=db.prepare("SELECT COALESCE(SUM(pnl),0) pnl,COALESCE(SUM(CASE WHEN status='open' THEN size ELSE 0 END),0) reserved FROM paper_trades").get() as {pnl:number;reserved:number};
    const alreadyInMarket=db.prepare("SELECT p.id FROM paper_trades p JOIN signals s ON s.id=p.signal_id WHERE s.market=? LIMIT 1").get(row.market);
    if(!alreadyInMarket && account+totals.pnl-totals.reserved>=r.size) db.prepare("INSERT OR IGNORE INTO paper_trades(signal_id,entry_price,current_price,size,pnl,status,opened_at) VALUES(?,?,?,?,0,'open',?)").run(row.id,row.current_price,row.current_price,r.size,now());
  }
  db.close();
}

async function updatePnl() {
  migrate(); const db = openDb(); const trades = db.prepare("SELECT p.*,s.token_id,s.side FROM paper_trades p JOIN signals s ON s.id=p.signal_id WHERE p.status='open'").all() as any[];
  for (const t of trades) { if(String(t.token_id).startsWith("demo-")) continue; const price=summarizeBook(await fetchBook(t.token_id)).price; const pnl=paperPnl(t.side,t.entry_price,price,t.size); db.prepare("UPDATE paper_trades SET current_price=?,pnl=? WHERE id=?").run(price,pnl,t.id); db.prepare("INSERT INTO pnl_snapshots(paper_trade_id,price,pnl,captured_at) VALUES(?,?,?,?)").run(t.id,price,pnl,now()); }
  db.close();
}

async function reviewOutcomes() {
  migrate(); const db=openDb();
  const trades=db.prepare("SELECT p.*,s.token_id,s.market_slug FROM paper_trades p JOIN signals s ON s.id=p.signal_id WHERE p.status='open' AND s.market_slug IS NOT NULL").all() as any[];
  for(const trade of trades) {
    const event=await fetchEventBySlug(trade.market_slug), market=event.markets?.[0];
    if(!event.closed || !market?.closed) continue;
    const tokenIds=JSON.parse(market.clobTokenIds || "[]") as string[], prices=JSON.parse(market.outcomePrices || "[]") as string[];
    const index=tokenIds.indexOf(String(trade.token_id)); if(index<0) throw new Error(`Resolved market did not contain paper token ${trade.token_id}`);
    const finalPrice=Number(prices[index]); if(finalPrice!==0 && finalPrice!==1) continue;
    const pnl=paperPnl("BUY",trade.entry_price,finalPrice,trade.size), status=finalPrice===1?"won":"lost";
    db.prepare("UPDATE paper_trades SET current_price=?,pnl=?,status=?,closed_at=? WHERE id=?").run(finalPrice,pnl,status,now(),trade.id);
    db.prepare("INSERT INTO pnl_snapshots(paper_trade_id,price,pnl,captured_at) VALUES(?,?,?,?)").run(trade.id,finalPrice,pnl,now());
  }
  const positions=db.prepare("SELECT * FROM paper_positions_v2 WHERE status='open'").all() as any[];
  for(const position of positions) {
    const event=await fetchEventBySlug(position.market_slug), market=event.markets?.[0]; if(!event.closed||!market?.closed) continue;
    const tokenIds=JSON.parse(market.clobTokenIds||"[]") as string[], prices=JSON.parse(market.outcomePrices||"[]") as string[];
    const index=tokenIds.indexOf(String(position.token_id)); if(index<0) throw new Error(`Resolved market did not contain mirror token ${position.token_id}`);
    const finalPrice=Number(prices[index]); if(finalPrice!==0&&finalPrice!==1) continue;
    const settlement=position.shares*finalPrice, finalPnl=settlement-position.cost_basis;
    db.prepare("UPDATE paper_positions_v2 SET realized_pnl=realized_pnl+?,current_price=?,shares=0,cost_basis=0,status=?,updated_at=?,closed_at=? WHERE token_id=?")
      .run(finalPnl,finalPrice,finalPrice===1?"won":"lost",now(),now(),position.token_id);
  }
  snapshotAccount(db);
  db.close();
}

async function runFinalMinuteProbability() {
  if(process.env.MARKET_MODE!=="btc5") { console.log("Final-minute probability rule idle: MARKET_MODE is not btc5."); return; }
  migrate(); const db=openDb();
  if((activeRules(db) as Rules&Record<string,unknown>).btc5FinalMinuteProbabilityEnabled!==1){console.log("Final-minute probability rule idle: rule set is not active.");db.close();return;}
  const unixNow=Math.floor(Date.now()/1000),start=Math.floor(unixNow/300)*300,secondsRemaining=start+300-unixNow,slug=`btc-updown-5m-${start}`;
  try {
    if(secondsRemaining<=0||secondsRemaining>60){console.log(`BTC final-minute ${slug}: wait; ${Math.max(0,secondsRemaining)}s remaining`);return;}
    const event=await fetchEventBySlug(slug),market=event.markets?.[0];
    const outcomes=JSON.parse(market?.outcomes||"[]") as string[],tokens=JSON.parse(market?.clobTokenIds||"[]") as string[];
    if(outcomes.length!==2||tokens.length!==2) throw new Error(`BTC final-minute market ${slug} did not expose two outcomes`);
    const rawBooks=await Promise.all(tokens.map(fetchBook)),books=rawBooks.map(summarizeBook);
    const probabilities=books.map((book,index)=>({outcome:outcomes[index],probability:book.bid>0&&book.ask<1?(book.bid+book.ask)/2:book.price}));
    const decision=decideFinalMinuteProbability({secondsRemaining,probabilities});
    if(decision.action!=="trade"){console.log(`BTC final-minute ${slug}: ${decision.action}; leader ${(decision.probability*100).toFixed(1)}%`);return;}
    const leaderIndex=outcomes.indexOf(decision.outcome!),oppositeIndex=leaderIndex===0?1:0,leaderToken=tokens[leaderIndex],oppositeToken=tokens[oppositeIndex],detectedAt=now();
    const opposite=db.prepare("SELECT * FROM paper_positions_v2 WHERE token_id=? AND status='open'").get(oppositeToken) as any;
    const sellEventKey=`final-minute-80:${slug}:${oppositeToken}:SELL`;
    if(opposite?.shares>0&&!db.prepare("SELECT id FROM copy_events WHERE event_key=?").get(sellEventKey)) {
      const book=books[oppositeIndex],fill=simulateSell(rawBooks[oppositeIndex],Number(opposite.shares));
      db.prepare("INSERT OR IGNORE INTO copy_events(event_key,wallet,market,market_slug,token_id,outcome,side,source_size,source_usdc,source_price,market_price,paper_dollars,paper_shares,decision,reason,created_at,source_timestamp,detected_at,latency_ms,requested_dollars,fill_ratio,fee_usdc,strategy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(sellEventKey,"deterministic-final-minute-80",event.title||slug,slug,oppositeToken,outcomes[oppositeIndex],"SELL",opposite.shares,0,book.bid,fill.avgPrice||book.bid,fill.proceeds,-fill.shares,fill.shares>0?"paper_copy":"skip",fill.shares>0?`Final minute: sold opposite outcome because ${decision.outcome} midpoint was ${(decision.probability*100).toFixed(1)}%`:"Final minute: no bid depth for opposite outcome",detectedAt,unixNow,detectedAt,0,0,fill.fillRatio,fill.fee,"btc5_final_minute_80pct");
      if(fill.shares>0){const fraction=fill.shares/opposite.shares,removedCost=opposite.cost_basis*fraction,remaining=opposite.shares-fill.shares;db.prepare("UPDATE paper_positions_v2 SET shares=?,cost_basis=?,realized_pnl=realized_pnl+?,current_price=?,status=?,updated_at=?,closed_at=? WHERE token_id=?").run(remaining,opposite.cost_basis-removedCost,fill.proceeds-removedCost,fill.avgPrice||book.bid,remaining<1e-9?"sold":"open",now(),remaining<1e-9?now():null,oppositeToken);}
    }
    const buyEventKey=`final-minute-80:${slug}:${leaderToken}:BUY`;
    if(db.prepare("SELECT id FROM copy_events WHERE event_key=?").get(buyEventKey))return;
    const totals=db.prepare("SELECT COALESCE(SUM(realized_pnl),0) realized,COALESCE(SUM(CASE WHEN status='open' THEN cost_basis ELSE 0 END),0) deployed FROM paper_positions_v2").get() as {realized:number;deployed:number};
    const account=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}).starting_balance,available=Math.max(0,account+totals.realized-totals.deployed);
    const requested=Math.max(0,Math.min(finalMinuteProbabilityPolicy.dollarsPerBuy,available,conservativeMirrorPolicy.maxPortfolioExposure-totals.deployed)),book=books[leaderIndex];
    const fill=requested>=5?simulateBuy(rawBooks[leaderIndex],requested):{shares:0,avgPrice:0,gross:0,fee:0,spent:0,fillRatio:0},copied=fill.shares>0;
    db.prepare("INSERT INTO copy_events(event_key,wallet,market,market_slug,token_id,outcome,side,source_size,source_usdc,source_price,market_price,paper_dollars,paper_shares,decision,reason,created_at,source_timestamp,detected_at,latency_ms,requested_dollars,fill_ratio,fee_usdc,strategy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(buyEventKey,"deterministic-final-minute-80",event.title||slug,slug,leaderToken,decision.outcome,"BUY",0,0,book.ask,fill.avgPrice||book.ask,fill.spent,fill.shares,copied?"paper_copy":"skip",copied?`Final minute: added $${fill.spent.toFixed(2)} to ${decision.outcome} at ${(decision.probability*100).toFixed(1)}% midpoint`:"Final-minute >80% signal found, but less than $5 cash/capacity or no ask depth was available",detectedAt,unixNow,detectedAt,0,requested,fill.fillRatio,fill.fee,"btc5_final_minute_80pct");
    if(copied)db.prepare(`INSERT INTO paper_positions_v2(token_id,wallet,market,market_slug,outcome,shares,cost_basis,current_price,status,opened_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'open',?,?) ON CONFLICT(token_id) DO UPDATE SET shares=shares+excluded.shares,cost_basis=cost_basis+excluded.cost_basis,current_price=excluded.current_price,status='open',closed_at=NULL,updated_at=excluded.updated_at`).run(leaderToken,"deterministic-final-minute-80",event.title||slug,slug,decision.outcome,fill.shares,fill.spent,fill.avgPrice||book.price,now(),now());
    snapshotAccount(db);
  } finally { db.close(); }
}

function activateFinalMinuteProbabilityRule() {
  migrate();const db=openDb();const current=activeRules(db) as Rules&Record<string,unknown>;
  const next={...current} as Record<string,unknown>;
  for(const key of ["minEntryPrice","maxEntryPrice","btc5EndWindowEnabled","btc5EndWindowSeconds","btc5AbsoluteGapUsd","btc5EndWindowBuyDollars"])delete next[key];
  Object.assign(next,{btc5FinalMinuteProbabilityEnabled:1,btc5FinalMinuteSeconds:60,btc5FinalMinuteMinimumProbability:.80,btc5FinalMinuteBuyDollars:25});
  const version=((db.prepare("SELECT MAX(version) v FROM rule_sets").get() as any).v||0)+1;db.exec("UPDATE rule_sets SET active=0");
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(?,1,?,?,?)").run(version,JSON.stringify(next),"User-requested removal of the 15c-85c entry band and final-30-second $25 reference-gap rule; replacement final-minute >80% midpoint rule sells the opposite holding and adds $25 to the leader; reviewed 88 completed positions before change",now());
  db.close();console.log(`Activated paper rule set ${version}: no entry-price band; final-minute midpoint >80%.`);
}

function updateRules() {
  migrate(); const db=openDb(); const rows=db.prepare("SELECT s.spread,s.liquidity,p.pnl FROM paper_trades p JOIN signals s ON s.id=p.signal_id WHERE p.status!='open'").all() as any[];
  if(rows.length<20){ console.log("No rule change: at least 20 completed paper trades are required."); db.close(); return; }
  const current=activeRules(db); const badWide=rows.filter(r=>r.spread>current.maxSpread*.75&&r.pnl<0).length; const next={...current}; let reason="";
  if(badWide/rows.length>=.25){next.maxSpread=Math.max(.01,Number((current.maxSpread-.005).toFixed(3)));reason="Wide-spread paper trades underperformed in at least 25% of the review sample";}
  if(!reason){console.log("No statistically guarded rule change suggested.");db.close();return;}
  const version=((db.prepare("SELECT MAX(version) v FROM rule_sets").get() as any).v||0)+1; db.exec("UPDATE rule_sets SET active=0"); db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(?,1,?,?,?)").run(version,JSON.stringify(next),reason,now()); db.close();
}

async function report() {
  migrate(); const db=openDb(); const stats=db.prepare("SELECT COUNT(*) n,SUM(status='open') open,SUM(status='won') won,SUM(status='lost') lost FROM paper_positions_v2").get() as any; const date=now().slice(0,10);
  const starting=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}|undefined)?.starting_balance||1000;
  const latest=db.prepare("SELECT * FROM account_snapshots ORDER BY id DESC LIMIT 1").get() as any,equity=Number(latest?.equity??starting),settled=Number(stats.won||0)+Number(stats.lost||0);
  const v5=db.prepare("SELECT COUNT(*) scans,SUM(decision='paper_complete_set') fills,COALESCE(SUM(locked_profit),0) profit FROM v5_opportunities").get() as {scans:number;fills:number;profit:number};
  const stream=db.prepare("SELECT status,transport,messages,subscribed_tokens,reconnects FROM v5_stream_state WHERE id=1").get() as {status:string;transport:string;messages:number;subscribed_tokens:number;reconnects:number}|undefined;
  const label=String((db.prepare("SELECT strategy FROM paper_accounts WHERE id=1").get() as {strategy:string}|undefined)?.strategy||"Paper bot");
  const summary=`${label} paper report ${date}\nPaper funding basis: $${starting.toFixed(2)}\nPaper equity: $${equity.toFixed(2)}\nLifetime paper PnL: $${(equity-starting).toFixed(2)}\nAvailable cash: $${Number(latest?.available_cash??starting).toFixed(2)}${stream?`\nData transport: ${stream.transport} (${stream.status})\nMarket-stream messages: ${stream.messages}\nSubscribed outcome tokens: ${stream.subscribed_tokens}\nWebSocket reconnects: ${stream.reconnects}`:""}\nComplete-set markets observed: ${Number(v5.scans||0)}\nFee-and-buffer-qualified fills: ${Number(v5.fills||0)}\nLocked complete-set profit: $${Number(v5.profit||0).toFixed(2)}\nOpen positions: ${Number(stats.open||0)}\nSettled win rate: ${settled?(Number(stats.won||0)/settled*100).toFixed(1):"0.0"}%\nSafety: no real trades were placed.`;
  let sent=0; if(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID){const res=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:summary})});if(!res.ok)throw new Error(`Telegram ${res.status}: ${await res.text()}`);sent=1;}
  db.prepare("INSERT INTO reports(report_date,summary,sent_to_telegram,created_at) VALUES(?,?,?,?) ON CONFLICT(report_date) DO UPDATE SET summary=excluded.summary,sent_to_telegram=excluded.sent_to_telegram,created_at=excluded.created_at").run(date,summary,sent,now()); db.close(); console.log(summary);
}

function startPaper() {
  const dataDir=path.join(process.cwd(),"data"), current=path.join(dataDir,"paperbot.db");
  if(fs.existsSync(current)) {
    const archiveDir=path.join(dataDir,"archive"); fs.mkdirSync(archiveDir,{recursive:true});
    const stamp=now().replace(/[:.]/g,"-"); fs.renameSync(current,path.join(archiveDir,`paperbot-before-btc5m-${stamp}.db`));
  }
  migrate(); const db=openDb();
  db.prepare("INSERT OR REPLACE INTO paper_accounts(id,starting_balance,strategy,created_at) VALUES(1,1000,'BTC Up or Down - 5 minute only',?)").run(now());
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(1,1,?,?,?)").run(JSON.stringify(defaultRules),"Safe BTC five-minute starter thresholds",now());
  db.close(); console.log("Archived the prior journal and started a clean $1,000 BTC five-minute paper account. Real capital at risk: $0.");
}

function startV5Paper() {
  const dataDir=path.join(process.cwd(),"data"),current=path.join(dataDir,"paperbot.db");
  if(fs.existsSync(current)){const archiveDir=path.join(dataDir,"archive");fs.mkdirSync(archiveDir,{recursive:true});const stamp=now().replace(/[:.]/g,"-");fs.renameSync(current,path.join(archiveDir,`paperbot-before-v5-${stamp}.db`));}
  migrate();const db=openDb(),created=now();
  db.prepare("INSERT INTO paper_accounts(id,starting_balance,strategy,created_at) VALUES(1,1000,'Crypto Execution Lab v5 · BTC/ETH 5m/15m complete sets',?)").run(created);
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(1,1,?,?,?)").run(JSON.stringify({strategy:"taker-complete-set-only",markets:["BTC-5m","BTC-15m","ETH-5m","ETH-15m"],...completeSetPolicy}),"Fresh $1,000 paper-only v5: equal paired shares only when visible asks, official crypto taker fees, and a 0.5-cent-per-pair execution reserve leave at least 1.5 cents net edge; based on a passing test suite, 20 reviewed completed trades, official Polymarket fee/merge rules, and public execution research",created);
  snapshotAccount(db);db.close();console.log("Archived the previous journal and started Crypto Execution Lab v5 with $1,000 paper capital. Real capital at risk: $0.");
}

async function scanV5CompleteSets(){
  migrate();const db=openDb(),unixNow=Math.floor(Date.now()/1000),date=now().slice(0,10);
  const account=(db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}|undefined);if(!account){db.close();throw new Error("Paper account is not initialized");}
  let observed=0,fills=0,profit=0;
  for(const spec of currentCryptoMarketSlugs(unixNow)){
    try{
      const existing=db.prepare("SELECT decision FROM v5_opportunities WHERE market_slug=?").get(spec.slug) as {decision:string}|undefined;if(existing?.decision==="paper_complete_set")continue;
      const event=await fetchEventBySlug(spec.slug),market=event.markets?.[0];if(!market||event.closed||market.closed)continue;
      const outcomes=JSON.parse(market.outcomes||"[]") as string[],tokens=JSON.parse(market.clobTokenIds||"[]") as string[];
      const upIndex=outcomes.findIndex(value=>/^(up|yes)$/i.test(value)),downIndex=outcomes.findIndex(value=>/^(down|no)$/i.test(value));if(upIndex<0||downIndex<0||!tokens[upIndex]||!tokens[downIndex])throw new Error("market did not expose Up and Down CLOB tokens");
      const [upBook,downBook]=await Promise.all([fetchBook(tokens[upIndex]),fetchBook(tokens[downIndex])]),up=summarizeBook(upBook),down=summarizeBook(downBook);
      const realized=(db.prepare("SELECT COALESCE(SUM(locked_profit),0) pnl FROM v5_opportunities WHERE decision='paper_complete_set'").get() as {pnl:number}).pnl,available=account.starting_balance+realized;
      const result=simulateCompleteSet(upBook,downBook,Math.min(completeSetPolicy.maxDollarsPerMarket,available)),stamp=now(),filled=result.decision==="paper_complete_set";
      db.prepare(`INSERT INTO v5_opportunities(market_slug,market,asset,minutes,up_token_id,down_token_id,up_ask,down_ask,raw_ask_sum,pairs,gross_cost,fee_usdc,execution_reserve,conservative_cost,locked_profit,net_edge_per_pair,decision,reason,first_seen_at,updated_at,filled_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(market_slug) DO UPDATE SET up_ask=excluded.up_ask,down_ask=excluded.down_ask,raw_ask_sum=excluded.raw_ask_sum,pairs=excluded.pairs,gross_cost=excluded.gross_cost,fee_usdc=excluded.fee_usdc,execution_reserve=excluded.execution_reserve,conservative_cost=excluded.conservative_cost,locked_profit=excluded.locked_profit,net_edge_per_pair=excluded.net_edge_per_pair,decision=excluded.decision,reason=excluded.reason,updated_at=excluded.updated_at,filled_at=excluded.filled_at`)
        .run(spec.slug,event.title||spec.slug,spec.asset,spec.minutes,tokens[upIndex],tokens[downIndex],up.ask,down.ask,up.ask+down.ask,result.pairs,result.gross,result.fees,result.buffer,result.conservativeCost,result.lockedProfit,result.netEdgePerPair,result.decision,result.reason,stamp,stamp,filled?stamp:null);
      observed++;if(filled){fills++;profit+=result.lockedProfit;console.log(`${spec.slug}: paper complete set ${result.pairs.toFixed(2)} pairs, locked $${result.lockedProfit.toFixed(2)}`)}
    }catch(error){console.warn(`${spec.slug}: scan unavailable: ${error instanceof Error?error.message:String(error)}`)}
  }
  db.prepare("INSERT INTO v5_daily_stats(report_date,scans,opportunities,fills,locked_profit,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(report_date) DO UPDATE SET scans=scans+excluded.scans,opportunities=opportunities+excluded.opportunities,fills=fills+excluded.fills,locked_profit=locked_profit+excluded.locked_profit,updated_at=excluded.updated_at").run(date,currentCryptoMarketSlugs(unixNow).length,observed,fills,profit,now());
  snapshotAccount(db);db.close();console.log(`v5 scan: ${observed} active markets, ${fills} new paper complete sets, $${profit.toFixed(2)} newly locked profit.`);
}

function startSingleProfilePaper() {
  const address=normalizeCopyProfile(process.env.COPY_PROFILE);if(!address)throw new Error("COPY_PROFILE is required");
  const label=String(process.env.COPY_PROFILE_LABEL||address),startingBalance=Number(process.env.PAPER_STARTING_BALANCE||1000),exact=process.env.PROFILE_SIZING==="exact",dataDir=path.join(process.cwd(),"data"),current=path.join(dataDir,"paperbot.db");
  if(!Number.isFinite(startingBalance)||startingBalance<=0)throw new Error("PAPER_STARTING_BALANCE must be positive");
  if(fs.existsSync(current)){const archiveDir=path.join(dataDir,"archive");fs.mkdirSync(archiveDir,{recursive:true});const stamp=now().replace(/[:.]/g,"-");fs.renameSync(current,path.join(archiveDir,`paperbot-before-single-profile-${stamp}.db`));}
  migrate();const db=openDb(),created=now();
  db.prepare("INSERT INTO paper_accounts(id,starting_balance,strategy,created_at) VALUES(1,?,?,?)").run(startingBalance,`L5ZN Exact Shadow Mirror · BTC/ETH 5m/15m: ${label}`,created);
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(1,1,?,?,?)").run(JSON.stringify({...defaultRules,markets:["BTC-5m","BTC-15m","ETH-5m","ETH-15m"],profileSizing:exact?"exact-source-shadow-ledger":"starting-fund-divided-by-live-profile-value"}),`Fresh $${startingBalance.toFixed(2)} L5ZN journal restricted to ${label} (${address}); ${exact?"exact source-reported dollars, shares, and public position marks; markets already active at startup excluded":"fund-ratio sizing"}; disputed sub-$5 1-cent feed guard; no independent strategy`,created);
  db.prepare("INSERT INTO wallets(address,label,category,pnl,volume,trades,resolved_trades,wins,largest_trade_pnl,average_liquidity,average_spread,average_price_move,roi_score,consistency_score,copyability_score,one_hit_penalty,global_score,status,reason,updated_at) VALUES(?,?,'BTC 5m',0,0,0,0,0,0,0,0,0,0,0,0,0,100,'track','Explicit user-selected copy source; 100 is a routing value, not a performance score',?)").run(address,label,created);
  snapshotAccount(db);db.close();
  console.log(`Archived the previous journal and started a clean $${startingBalance.toFixed(2)} BTC/ETH 5/15-minute paper account copying only ${label} (${address}) with ${exact?"exact source-dollar":"fund-ratio"} sizing.`);
}

function activateExpandedSingleProfile() {
  migrate();const db=openDb(),address=normalizeCopyProfile(process.env.COPY_PROFILE);if(!address){db.close();throw new Error("COPY_PROFILE is required");}
  const selected=db.prepare("SELECT address,label FROM wallets WHERE status='track'").all() as {address:string;label:string}[];
  if(selected.length!==1||selected[0].address.toLowerCase()!==address){db.close();throw new Error("Active journal is not isolated to the configured profile");}
  const current=activeRules(db) as Rules&Record<string,unknown>,next={...current,markets:["BTC-5m","BTC-15m","ETH-5m","ETH-15m"],singleProfile:address,independentFinalMinuteStrategy:0};
  const version=((db.prepare("SELECT MAX(version) v FROM rule_sets").get() as any).v||0)+1;db.exec("UPDATE rule_sets SET active=0");
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(?,1,?,?,?)").run(version,JSON.stringify(next),"Expanded l5Zn1bWoM8eTsK-only paper copying from BTC 5m to BTC/ETH 5m/15m; reviewed 113 archived completed positions; no leaderboard or independent final-minute entries",now());
  db.prepare("UPDATE paper_accounts SET strategy='L5ZN Crypto Mirror · BTC/ETH 5m/15m · l5Zn1bWoM8eTsK only' WHERE id=1").run();db.close();
  console.log(`Activated L5ZN Crypto Mirror rule set ${version}: BTC/ETH 5m/15m, one profile only.`);
}

function activateExactCashLimitedMirror() {
  migrate();const db=openDb(),address=normalizeCopyProfile(process.env.COPY_PROFILE);if(!address){db.close();throw new Error("COPY_PROFILE is required");}
  const selected=db.prepare("SELECT address FROM wallets WHERE status='track'").all() as {address:string}[];
  if(selected.length!==1||selected[0].address.toLowerCase()!==address){db.close();throw new Error("Active journal is not isolated to the configured profile");}
  const current=activeRules(db) as Rules&Record<string,unknown>,next={...current,profileSizing:"dollar-for-dollar-until-cash",profileExposureCaps:0,disputedOneCentDustGuard:1};
  const version=((db.prepare("SELECT MAX(version) v FROM rule_sets").get() as any).v||0)+1;db.exec("UPDATE rule_sets SET active=0");
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(?,1,?,?,?)").run(version,JSON.stringify(next),"Dollar-for-dollar source-action copying until paper cash is exhausted; removed per-outcome, per-market, and portfolio exposure ceilings after 25 passing tests and review of 20 completed archived positions; retained the disputed sub-$5 1-cent feed guard",now());
  db.prepare("UPDATE paper_accounts SET strategy='L5ZN Crypto Mirror v3 · exact source dollars until $1,000 paper cash is used' WHERE id=1").run();db.close();
  console.log(`Activated L5ZN exact cash-limited mirror rule set ${version}.`);
}

function activateFundRatioMirror() {
  migrate();const db=openDb(),current=activeRules(db) as Rules&Record<string,unknown>,next={...current,profileSizing:"starting-fund-divided-by-live-profile-value"};
  const version=((db.prepare("SELECT MAX(version) v FROM rule_sets").get() as any).v||0)+1;db.exec("UPDATE rule_sets SET active=0");
  db.prepare("INSERT INTO rule_sets(version,active,rules_json,reason,created_at) VALUES(?,1,?,?,?)").run(version,JSON.stringify(next),"User-requested proportional mirror: each source action is multiplied by $1,000 paper starting fund divided by the profile's live public portfolio value; paper cash remains the hard cap",now());
  db.prepare("UPDATE paper_accounts SET strategy='L5ZN Crypto Mirror v4 · live fund-ratio sizing' WHERE id=1").run();db.close();console.log(`Activated fund-ratio mirror rule set ${version}.`);
}

function addPaperFunds() {
  migrate(); const amount=Number(process.env.PAPER_FUND_AMOUNT||1000);
  if(!Number.isFinite(amount)||amount<=0||amount>100000) throw new Error("PAPER_FUND_AMOUNT must be between 0 and 100000");
  const db=openDb(); const account=db.prepare("SELECT starting_balance FROM paper_accounts WHERE id=1").get() as {starting_balance:number}|undefined;
  if(!account) { db.close(); throw new Error("Paper account is not initialized"); }
  const balance=account.starting_balance+amount;
  db.prepare("UPDATE paper_accounts SET starting_balance=? WHERE id=1").run(balance);
  db.prepare("INSERT INTO funding_events(amount,balance_after,note,created_at) VALUES(?,?,?,?)").run(amount,balance,"User-requested simulated funding; no real funds",now());
  snapshotAccount(db); db.close();
  console.log(`Added $${amount.toFixed(2)} simulated funds. Paper funding basis is now $${balance.toFixed(2)}. Real funds added: $0.`);
}

async function cycle(){ await leaderboard(); await monitor(); scoreSignals(); await updatePnl(); await reviewOutcomes(); updateRules(); await report(); }
const command=process.argv[2]||"help"; const tasks:Record<string,()=>unknown>={migrate,seed,start:startPaper,"start-v5":startV5Paper,"v5-scan":scanV5CompleteSets,"start-profile":startSingleProfilePaper,"activate-single-expanded":activateExpandedSingleProfile,"activate-exact-mirror":activateExactCashLimitedMirror,"activate-ratio-mirror":activateFundRatioMirror,fund:addPaperFunds,leaderboard,wallets:leaderboard,monitor,score:scoreSignals,pnl:updatePnl,"final-minute":runFinalMinuteProbability,"activate-final-minute":activateFinalMinuteProbabilityRule,outcomes:reviewOutcomes,rules:updateRules,report,cycle};
if(!tasks[command]){console.log(`Commands: ${Object.keys(tasks).join(", ")}`);process.exitCode=1;}else await tasks[command]();
