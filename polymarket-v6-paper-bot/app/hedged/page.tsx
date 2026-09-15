import {queryAll} from "../../lib/db";
import TradingVisuals from "../trading-visuals";

export const dynamic="force-dynamic";
type Snapshot={equity:number;available_cash:number;deployed:number;captured_at:string};
type Event={id:number;market:string;phase:string;tier:string|null;outcome:string;probability:number;filled_dollars:number;shares:number;avg_price:number;fee_usdc:number;fill_ratio:number;reason:string;created_at:string};
type Position={token_id:string;market:string;outcome:string;shares:number;cost_basis:number;current_price:number;realized_pnl:number;status:string};
const money=(n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);

export default function HedgedDashboard(){
  const account=queryAll<{starting_balance:number;strategy:string}>("SELECT starting_balance,strategy FROM ha_account WHERE id=1")[0]||{starting_balance:1000,strategy:"Hedged Momentum Accumulator"};
  const snapshots=queryAll<Snapshot>("SELECT equity,available_cash,deployed,captured_at FROM (SELECT id,equity,available_cash,deployed,captured_at FROM ha_snapshots ORDER BY id DESC LIMIT 240) ORDER BY id ASC").map(row=>({...row}));
  const events=queryAll<Event>("SELECT * FROM ha_events ORDER BY id DESC LIMIT 100").map(row=>({...row})),positions=queryAll<Position>("SELECT * FROM ha_positions ORDER BY updated_at DESC");
  const stream=queryAll<{status:string;messages:number;subscribed_tokens:number;reconnects:number}>("SELECT status,messages,subscribed_tokens,reconnects FROM v5_stream_state WHERE id=1")[0],report=queryAll<{summary:string}>("SELECT summary FROM ha_reports ORDER BY report_date DESC LIMIT 1")[0];
  const latest=snapshots.at(-1),equity=latest?.equity??account.starting_balance,available=latest?.available_cash??account.starting_balance,deployed=latest?.deployed??0,pnl=equity-account.starting_balance,open=positions.filter(position=>position.status==="open");
  return <main>
    <header><div><span className="eyebrow">SEPARATE PAPER STRATEGY · SHARED LIVE FEED</span><h1>Hedged Momentum <i>Accumulator</i></h1><p>Small cheap-side insurance · progressively larger confirmed-leader additions · hold both sides to settlement.</p><a className="bot-switch" href="/">← Complete-Set Lab v5</a></div><div className={`status ${stream?.status||"starting"}`}><span/> WEBSOCKET {String(stream?.status||"STARTING").toUpperCase()} · PAPER ONLY</div></header>
    <section className="hero">
      <div><small>Paper account equity</small><strong className={pnl>=0?"positive":"negative"}>{money(equity)}</strong><em>{money(pnl)} P&amp;L · separate $1,000 ledger</em></div>
      <div><small>Available cash</small><strong>{money(available)}</strong><em>{money(deployed)} deployed</em></div>
      <div><small>Paper buys</small><strong>{events.length}</strong><em>{events.filter(event=>event.phase==="insurance").length} insurance · {events.filter(event=>event.phase==="leader_add").length} leader adds</em></div>
      <div><small>Open positions</small><strong>{open.length}</strong><em>never sold before settlement</em></div>
      <div><small>Shared WebSocket</small><strong>{stream?.subscribed_tokens||0}</strong><em>outcome tokens · {stream?.reconnects||0} reconnects</em></div>
    </section>
    <TradingVisuals snapshots={snapshots} events={[]} mode="hedged" startingBalance={account.starting_balance}/>
    <section className="event-ledger"><div className="section-title"><div><small>ACCUMULATION LEDGER</small><h2>Insurance and confirmed-leader buys</h2></div><span>{events.length} paper actions</span></div>
      {events.map(event=><div className="event-row v5-row" key={event.id}><mark className={event.phase==="insurance"?"sell":"buy"}>{event.phase==="insurance"?"INSURE":event.tier?.replace("leader_","")+"%"}</mark><div><b>{event.market} · {event.outcome}</b><small>{event.reason}</small><small>{(event.probability*100).toFixed(1)}% implied · {(event.fill_ratio*100).toFixed(0)}% depth fill · {money(event.fee_usdc)} fee</small></div><div><small>Paper cost</small><b>{money(event.filled_dollars)}</b></div><div><small>Shares</small><b>{event.shares.toFixed(2)}</b></div><div><small>Average</small><b>{(event.avg_price*100).toFixed(1)}¢</b></div></div>)}
      {!events.length&&<div className="empty-state"><b>Waiting for a valid insurance setup.</b><span>The bot will not force an entry merely because a new market opened.</span></div>}
    </section>
    <section className="mirror-positions"><div className="section-title"><div><small>HOLD-TO-SETTLEMENT BOOK</small><h2>Current hedged positions</h2></div><span>{open.length} open</span></div>{positions.map(position=><div className="trade" key={position.token_id}><div><b>{position.market} · {position.outcome}</b><small>{position.shares.toFixed(2)} shares · {money(position.cost_basis)} cost · {(position.current_price*100).toFixed(1)}¢ executable mark · {position.status.toUpperCase()}</small></div><strong className={position.realized_pnl>=0?"positive":"negative"}>{position.status==="open"?money(position.shares*position.current_price):money(position.realized_pnl)}</strong></div>)}{!positions.length&&<div className="empty-state"><span>No positions yet.</span></div>}</section>
    <section className="grid"><article><div className="section-title"><div><small>01 / POSITION BUILD</small><h2>Why the hedge is small</h2></div></div><div className="note"><b>$10 insurance</b><p>Only during the first 10%–55% of the market, when the cheaper outcome is at most 35%, its ask is at most 40¢, and its spread is no wider than 8¢.</p></div><div className="note"><b>$25 → $45 → $60 total exposure</b><p>The bot adds to the current leader only after stable, rising 72%, 82%, and 90% probability confirmations. It never opens new exposure in the final 20 seconds.</p></div></article><article><div className="section-title"><div><small>02 / LOSS CONTROL</small><h2>What it refuses to do</h2></div></div><div className="note"><b>No panic sale</b><p>The insurance leg is held to settlement, avoiding a forced sale into a poor bid.</p></div><div className="note"><b>Cash and market caps remain</b><p>The equity stop is disabled. New paper entries continue while at least $5 cash is available; each market remains capped at $60 and every fill still includes visible depth and crypto taker fees.</p></div></article></section>
    <section className="report"><small>LATEST HEDGED BRIEF</small><pre>{report?.summary||"The first report will appear within one minute."}</pre></section>
    <footer><span>Hedged Momentum Accumulator / v1</span><span>PUBLIC WEBSOCKET · DETERMINISTIC RULES · ZERO EXECUTION</span></footer>
  </main>
}
