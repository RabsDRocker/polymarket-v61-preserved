"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Snapshot={equity:number;available_cash:number;deployed:number;captured_at:string};
type Event={id:number;side:string;market:string;outcome:string|null;source_usdc:number;paper_dollars:number;decision:string;reason:string;created_at:string;wallet:string;latency_ms:number|null;fill_ratio:number;fee_usdc:number;strategy:string};

export default function TradingVisuals({snapshots,events,mode="mirror",startingBalance=1000}:{snapshots:Snapshot[];events:Event[];mode?:"mirror"|"v5"|"hedged";startingBalance?:number}){
  const router=useRouter();
  useEffect(()=>{const timer=window.setInterval(()=>router.refresh(),10000);return()=>window.clearInterval(timer)},[router]);
  const [filter,setFilter]=useState("ALL");
  const shown=useMemo(()=>events.filter(event=>filter==="ALL"||event.side===filter),[events,filter]);
  const points=snapshots.length?snapshots:[{equity:1000,available_cash:1000,deployed:0,captured_at:new Date().toISOString()}];
  const values=points.map(point=>point.equity), min=Math.min(...values,999), max=Math.max(...values,1001), range=Math.max(1,max-min);
  const polyline=points.map((point,index)=>`${20+(index/Math.max(1,points.length-1))*760},${170-((point.equity-min)/range)*130}`).join(" ");
  return <>
    <section className="visual-grid">
      <article className="chart-panel"><div className="section-title"><div><small>LIVE PAPER EQUITY · AUTO-REFRESH 10S</small><h2>Account path</h2></div><span>{points.length} snapshots</span></div>
        <svg className="equity-chart" viewBox="0 0 800 200" role="img" aria-label="Paper account equity over time"><line x1="20" y1="170" x2="780" y2="170"/><line x1="20" y1="40" x2="20" y2="170"/><polyline points={polyline}/><text x="26" y="34">{`$${max.toFixed(2)}`}</text><text x="26" y="188">{`$${min.toFixed(2)}`}</text></svg>
      </article>
      <article className="allocation"><div className="section-title"><div><small>CAPITAL ALLOCATION</small><h2>Where the ${startingBalance.toLocaleString()} sits</h2></div></div>
        <div className="allocation-track"><span style={{width:`${Math.min(100,(points.at(-1)!.deployed/Math.max(1,startingBalance))*100)}%`}}/></div><div className="allocation-key"><span>Deployed <b>${points.at(-1)!.deployed.toFixed(2)}</b></span><span>Available <b>${points.at(-1)!.available_cash.toFixed(2)}</b></span></div>
        <details><summary>Strategy followed</summary>{mode==="v5"?<ol><li>Discover current BTC and ETH 5-minute and 15-minute tokens, then subscribe to Polymarket's public market WebSocket.</li><li>Maintain full local books from `book` snapshots and incremental `price_change` events.</li><li>Walk visible asks on Up and Down together, using the shallower leg as the maximum pair size.</li><li>Include Polymarket crypto taker fees and reserve another 0.5¢ per pair for execution uncertainty.</li><li>Accept only if at least 1.5¢ per pair and $0.25 total locked profit remain; cap each market at $100.</li><li>Reconnect, resubscribe, and remain paper-only without ever signing or submitting an order.</li></ol>:mode==="hedged"?<ol><li>Buy $10 of the inexpensive outcome as insurance only when its probability, ask, spread, and timing qualify.</li><li>Track both outcome probabilities from the live WebSocket order books.</li><li>Add to the current leader only after stable rising confirmation at 72%, 82%, or 90%.</li><li>Cap total paper exposure at $25, $45, and $60 as confidence rises.</li><li>Hold both outcomes to settlement; never sell the losing insurance at an unfavorable bid.</li><li>Continue while at least $5 paper cash remains; the equity drawdown stop is disabled, but no entries occur in the final 20 seconds.</li></ol>:<ol><li>Watch only l5Zn1bWoM8eTsK at wallet 0xb945…db68.</li><li>Begin with the first complete BTC/ETH 5-minute or 15-minute market after startup; never join an already-running strategy halfway through.</li><li>Shadow the source-reported dollars and shares exactly while paper cash remains.</li><li>Use the profile's public aggregate position mark so position values are directly comparable.</li><li>Reject only invalid activity and the disputed sub-$5 1¢ public-feed anomaly.</li><li>Settle every remaining paper position at $1 or $0.</li></ol>}</details>
      </article>
    </section>
    {mode==="mirror"&&<section className="event-ledger"><div className="section-title"><div><small>MIRROR LEDGER</small><h2>Profile actions copied</h2></div><div className="filters">{["ALL","BUY","SELL"].map(value=><button key={value} className={filter===value?"active":""} onClick={()=>setFilter(value)}>{value}</button>)}</div></div>
      <div aria-live="polite">{shown.slice(0,16).map(event=><div className="event-row" key={event.id}><mark className={event.side.toLowerCase()}>{event.side}</mark><div><b>{event.market}</b><small>{event.outcome||"Outcome"} · {event.wallet.slice(0,8)}… · {event.reason}</small><small>{event.latency_ms!=null?`${(event.latency_ms/1000).toFixed(1)}s detected latency · `:"legacy event · "}{(event.fill_ratio*100).toFixed(0)}% depth fill · ${event.fee_usdc.toFixed(4)} fee</small></div><div><small>Source</small><b>${event.source_usdc.toFixed(2)}</b></div><div><small>Paper</small><b>${event.paper_dollars.toFixed(2)}</b></div><mark className={event.decision}>{event.decision.replace("_"," ")}</mark></div>)}</div>
    </section>}
    <section className="strategy-flow">{mode==="v5"?<><div><b>MARKET WEBSOCKET</b><small>Snapshots + live deltas</small></div><i>→</i><div><b>EQUAL PAIRS</b><small>Up + Down asks</small></div><i>→</i><div><b>COST TEST</b><small>Depth · fees · reserve</small></div><i>→</i><div><b>MERGE OR WAIT</b><small>Locked paper profit only</small></div></>:mode==="hedged"?<><div><b>$10 INSURANCE</b><small>Cheap liquid outcome</small></div><i>→</i><div><b>CONFIRM LEADER</b><small>72% · 82% · 90%</small></div><i>→</i><div><b>ADD GRADUALLY</b><small>$25 · $45 · $60 cap</small></div><i>→</i><div><b>HOLD BOTH</b><small>Settle at $1 or $0</small></div></>:<><div><b>ONE PROFILE</b><small>l5Zn1bWoM8eTsK</small></div><i>→</i><div><b>BTC + ETH</b><small>5m · 15m</small></div><i>→</i><div><b>REALISTIC FILL</b><small>Depth · partials · fees</small></div><i>→</i><div><b>PAPER POSITION</b><small>$1,000 journal</small></div></>}</section>
  </>
}
