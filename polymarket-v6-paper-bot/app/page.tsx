import { queryAll } from "../lib/db";
import TradingVisuals from "./trading-visuals";

export const dynamic = "force-dynamic";
type Wallet={address:string;label:string;category:string;global_score:number;roi_score:number;consistency_score:number;copyability_score:number;one_hit_penalty:number;status:string;reason:string};
type Signal={id:number;market:string;category:string;score:number;decision:string;reason:string;spread:number;liquidity:number;wallet_entry:number;current_price:number};
type Trade={id:number;market:string;size:number;entry_price:number;current_price:number;pnl:number;status:string};
type Snapshot={equity:number;available_cash:number;deployed:number;captured_at:string};
type V5Opportunity={market_slug:string;market:string;asset:string;minutes:number;up_ask:number;down_ask:number;raw_ask_sum:number;pairs:number;gross_cost:number;fee_usdc:number;execution_reserve:number;conservative_cost:number;locked_profit:number;net_edge_per_pair:number;decision:string;reason:string;updated_at:string;filled_at:string|null};
type StreamState={status:string;transport:string;connected_at:string|null;last_message_at:string|null;messages:number;reconnects:number;subscribed_tokens:number;last_error:string|null;updated_at:string};
const money=(n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
const short=(s:string)=>s.length>18?`${s.slice(0,8)}…${s.slice(-5)}`:s;

function V5Dashboard({account,snapshots,opportunities,stats,stream,report}:{account:{starting_balance:number;strategy:string};snapshots:Snapshot[];opportunities:V5Opportunity[];stats:{scans:number;opportunities:number;fills:number;locked_profit:number};stream?:StreamState;report?:{summary:string;created_at:string}}){
  const latest=snapshots.at(-1),equity=latest?.equity??account.starting_balance,available=latest?.available_cash??account.starting_balance;
  const lifetimeProfit=opportunities.filter(item=>item.decision==="paper_complete_set").reduce((sum,item)=>sum+item.locked_profit,0);
  const dailyGap=Math.max(0,100-stats.locked_profit),qualified=opportunities.filter(item=>item.decision==="paper_complete_set").length;
  return <main>
    <header><div><span className="eyebrow">PAPER-ONLY CRYPTO EXECUTION RESEARCH</span><h1>Crypto Execution <i>Lab v5</i></h1><p>BTC and ETH · 5-minute and 15-minute markets · paired-outcome complete sets only.</p><a className="bot-switch" href="/hedged">Open Hedged Momentum Accumulator →</a></div><div className={`status ${stream?.status||"starting"}`}><span/> WEBSOCKET {String(stream?.status||"STARTING").toUpperCase()} · NO LIVE ORDERS</div></header>
    <section className="hero">
      <div><small>Paper account equity</small><strong className={lifetimeProfit>=0?"positive":"negative"}>{money(equity)}</strong><em>{money(lifetimeProfit)} locked P&amp;L · real capital at risk: $0</em></div>
      <div><small>Available paper cash</small><strong>{money(available)}</strong><em>complete sets are merged immediately</em></div>
      <div><small>WebSocket messages</small><strong>{stream?.messages||0}</strong><em>{stream?.subscribed_tokens||0} outcome tokens · {stream?.reconnects||0} reconnects</em></div>
      <div><small>Qualified fills</small><strong>{qualified}</strong><em>fees and reserve already deducted</em></div>
      <div><small>$100/day stretch gap</small><strong>{money(dailyGap)}</strong><em>benchmark only · never guaranteed</em></div>
    </section>
    <TradingVisuals snapshots={snapshots} events={[]} mode="v5" startingBalance={account.starting_balance}/>
    <section className="event-ledger"><div className="section-title"><div><small>COMPLETE-SET SCAN LEDGER</small><h2>What the bot saw and decided</h2></div><span>{opportunities.length} recent markets</span></div>
      <div>{opportunities.map(item=><div className="event-row v5-row" key={item.market_slug}><mark className={item.decision==="paper_complete_set"?"buy":"observe"}>{item.decision==="paper_complete_set"?"LOCKED":"OBSERVE"}</mark><div><b>{item.market}</b><small>{item.asset} {item.minutes}m · Up {(item.up_ask*100).toFixed(1)}¢ + Down {(item.down_ask*100).toFixed(1)}¢ = {(item.raw_ask_sum*100).toFixed(1)}¢ before fees</small><small>{item.reason}</small></div><div><small>Equal pairs</small><b>{item.pairs.toFixed(2)}</b></div><div><small>Fees + reserve</small><b>{money(item.fee_usdc+item.execution_reserve)}</b></div><div><small>Locked P&amp;L</small><b className={item.locked_profit>0?"positive":""}>{money(Math.max(0,item.locked_profit))}</b></div></div>)}</div>
      {!opportunities.length&&<div className="empty-state"><b>Waiting for the first public order-book scan.</b><span>The scanner will show each current BTC/ETH 5m and 15m market here.</span></div>}
    </section>
    <section className="grid">
      <article><div className="section-title"><div><small>01 / ACCEPTANCE RULE</small><h2>Profit before prediction</h2></div></div><div className="note"><b>Buy both sides, equally</b><p>One Up share plus one Down share redeems for $1. The bot accepts only when the visible cost of both legs, taker fees, and an extra execution reserve still leave at least 1.5¢ per pair.</p></div><div className="note"><b>Minimum useful trade</b><p>It requires at least $0.25 of locked profit and limits each market to $100. If either side lacks depth, the equal-pair size shrinks to the shallower side.</p></div></article>
      <article><div className="section-title"><div><small>02 / HONEST SCORECARD</small><h2>Today</h2></div></div><div className="note"><b>{money(stats.locked_profit)} locked</b><p>{stats.fills} new fee-and-buffer-qualified paper fills. The $100 daily target is a stretch benchmark, not a promised return.</p></div><div className="note"><b>No forced trades</b><p>If no order book clears the safety threshold, staying in cash is the correct output. Observation is not a missed fill.</p></div></article>
    </section>
    <section className="report"><small>LATEST PAPER BRIEF</small><pre>{report?.summary||"The first report will appear after the scanner cycle."}</pre></section>
    <footer><span>Crypto Execution Lab / v5</span><span>PUBLIC DATA · DETERMINISTIC ACCOUNTING · ZERO EXECUTION</span></footer>
  </main>
}

export default function Home(){
  const wallets=queryAll<Wallet>("SELECT * FROM wallets ORDER BY global_score DESC LIMIT 20");
  const signals=queryAll<Signal>("SELECT * FROM signals ORDER BY created_at DESC LIMIT 20");
  const trades=queryAll<Trade>("SELECT p.*,s.market FROM paper_trades p JOIN signals s ON s.id=p.signal_id ORDER BY p.opened_at DESC");
  const reports=queryAll<{summary:string;created_at:string}>("SELECT * FROM reports ORDER BY created_at DESC LIMIT 1");
  const account=queryAll<{starting_balance:number;strategy:string}>("SELECT starting_balance,strategy FROM paper_accounts WHERE id=1")[0]||{starting_balance:1000,strategy:"BTC Up or Down - 5 minute only"};
  const mirrorPositions=queryAll<{token_id:string;market:string;outcome:string;shares:number;cost_basis:number;realized_pnl:number;current_price:number;status:string}>("SELECT * FROM paper_positions_v2 ORDER BY updated_at DESC");
  // node:sqlite rows have a null prototype. Spread them into plain objects before
  // crossing the Server Component boundary into the interactive client charts.
  const mirrorEvents=queryAll<{id:number;side:string;market:string;outcome:string|null;source_usdc:number;paper_dollars:number;decision:string;reason:string;created_at:string;wallet:string;latency_ms:number|null;fill_ratio:number;fee_usdc:number;strategy:string}>("SELECT * FROM copy_events ORDER BY created_at DESC LIMIT 100").map(row=>({...row}));
  const snapshots=queryAll<Snapshot>("SELECT equity,available_cash,deployed,captured_at FROM (SELECT id,equity,available_cash,deployed,captured_at FROM account_snapshots ORDER BY id DESC LIMIT 240) ORDER BY id ASC").map(row=>({...row}));
  const v5Opportunities=queryAll<V5Opportunity>("SELECT * FROM v5_opportunities ORDER BY updated_at DESC LIMIT 100").map(row=>({...row}));
  const v5Stats=queryAll<{scans:number;opportunities:number;fills:number;locked_profit:number}>("SELECT COALESCE(SUM(scans),0) scans,COALESCE(SUM(opportunities),0) opportunities,COALESCE(SUM(fills),0) fills,COALESCE(SUM(locked_profit),0) locked_profit FROM v5_daily_stats WHERE report_date=date('now')")[0]||{scans:0,opportunities:0,fills:0,locked_profit:0};
  const streamState=queryAll<StreamState>("SELECT * FROM v5_stream_state WHERE id=1")[0];
  if(account.strategy.includes("Crypto Execution Lab v5"))return <V5Dashboard account={account} snapshots={snapshots} opportunities={v5Opportunities} stats={v5Stats} stream={streamState} report={reports[0]}/>;
  const legacyPnl=trades.reduce((s,t)=>s+t.pnl,0), wins=trades.filter(t=>t.pnl>0).length;
  const latest=snapshots.at(-1), equity=latest?.equity??account.starting_balance+legacyPnl, pnl=equity-account.starting_balance;
  const available=latest?.available_cash??equity, deployed=latest?.deployed??0, openMirror=mirrorPositions.filter(position=>position.status==="open").length;
  const positionValue=mirrorPositions.filter(position=>position.status==="open").reduce((sum,position)=>sum+position.shares*position.current_price,0);
  const mirrorState=queryAll<{profile_value:number;copy_ratio:number;updated_at:string}>("SELECT * FROM mirror_state WHERE id=1")[0];
  return <main>
    <header><div><span className="eyebrow">SINGLE-PROFILE COPY RESEARCH</span><h1>L5ZN Crypto <i>Mirror</i></h1><p>l5Zn1bWoM8eTsK only · BTC and ETH · 5-minute and 15-minute markets. Every fill is simulated.</p></div><div className="status"><span/> PAPER ACCOUNT · ZERO EXECUTION</div></header>
    <section className="hero">
      <div><small>Paper account equity</small><strong className={pnl>=0?"positive":"negative"}>{money(equity)}</strong><em>{money(pnl)} P&amp;L · real capital at risk: $0</em></div>
      <div><small>Available paper cash</small><strong>{money(available)}</strong><em>{money(deployed)} in open simulations</em></div>
      <div><small>Copy sources</small><strong>{wallets.filter(w=>w.status==="track").length}</strong><em>one explicitly selected profile</em></div>
      <div><small>Current position value</small><strong>{money(positionValue)}</strong><em>{openMirror} positions · {mirrorState?(mirrorState.copy_ratio*100).toFixed(2):"—"}% source scale</em></div>
      <div><small>Fresh signals</small><strong>{signals.length}</strong><em>{signals.filter(s=>s.decision==="paper_copy").length} passed filters</em></div>
    </section>
    <TradingVisuals snapshots={snapshots} events={mirrorEvents}/>
    <section className="mirror-positions"><div className="section-title"><div><small>AGGREGATED MIRROR POSITIONS</small><h2>Buys added, sells reduced</h2></div></div>{mirrorPositions.map(position=>{const value=position.status==="open"?position.shares*position.current_price:0;return <div className="trade" key={position.token_id}><div><b>{position.market} · {position.outcome}</b><small>{position.shares.toFixed(2)} shares · {money(position.cost_basis)} remaining cost · {(position.current_price*100).toFixed(1)}¢ profile mark · {position.status.toUpperCase()}</small></div><strong>{money(value)}<small> position value</small></strong></div>})}</section>
    <section className="grid">
      <article className="wide"><div className="section-title"><div><small>01 / SELECTED PROFILE</small><h2>L5ZN mirror source</h2></div><span>routing identity · not a performance score</span></div>
        <div className="table"><div className="row head"><span>Wallet</span><span>Edge</span><span>Repeat</span><span>Copy</span><span>Score</span><span>Verdict</span></div>{wallets.map(w=><div className="row" key={w.address}><span><b>{w.label||short(w.address)}</b><small>{w.category}</small></span><span>{w.roi_score.toFixed(0)}</span><span>{w.consistency_score.toFixed(0)}</span><span>{w.copyability_score.toFixed(0)}</span><span><b>{w.global_score.toFixed(0)}</b></span><span><mark className={w.status}>{w.status}</mark></span></div>)}</div>
      </article>
      <article><div className="section-title"><div><small>02 / BOT MEMORY</small><h2>What changed?</h2></div></div><div className="note"><b>Rules stay conservative</b><p>Codex can propose and run evidence-based paper-rule updates. A change needs at least 20 completed simulations and is always versioned.</p></div><div className="note"><b>One-hit wonders lose points</b><p>A profitable wallet is not automatically copyable. Concentrated profit, wide spreads, and delayed entries reduce its score.</p></div></article>
    </section>
    <section className="grid">
      <article><div className="section-title"><div><small>03 / DECISION QUEUE</small><h2>Trade signals</h2></div></div>{signals.map(s=><div className="signal" key={s.id}><div><mark className={s.decision}>{s.decision.replace("_"," ")}</mark><b>{s.market}</b><small>{s.reason}</small></div><strong>{s.score.toFixed(0)}</strong></div>)}</article>
      <article><div className="section-title"><div><small>04 / SIMULATED BOOK</small><h2>Paper positions</h2></div></div>{trades.map(t=><div className="trade" key={t.id}><div><b>{t.market}</b><small>{money(t.size)} simulated · {t.entry_price.toFixed(2)} → {t.current_price.toFixed(2)} · {t.status.toUpperCase()}</small></div><strong className={t.pnl>=0?"positive":"negative"}>{money(t.pnl)}</strong></div>)}</article>
    </section>
    <section className="report"><small>END-OF-DAY BRIEF</small><pre>{reports[0]?.summary||"Run npm run report:daily after the first research cycle."}</pre></section>
    <footer><span>Signal Desk / v1</span><span>PUBLIC DATA · DETERMINISTIC SCORING · ZERO EXECUTION</span></footer>
  </main>
}
