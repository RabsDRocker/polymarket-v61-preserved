import test from "node:test";import assert from "node:assert/strict";
import {assertActionDependency,assertRiskBudget,effectiveBuyAmount,executableSellShares,meetsMinimumShares,percentageOfCapital,scaledLiveBuy,v61ActionKind,v61LiveEntryPercent,validateIntent,type Intent,type Limits} from "../src/core.ts";
import {DatabaseSync} from "node:sqlite";
import {portfolioTotals} from "../src/sdk.ts";
import {migrate,nextIntent,queueIntent,recordAcceptedFill,recoverInterruptedSubmissions,transition} from "../src/store.ts";
const limits:Limits={maxOrderUsd:2,maxTotalExposureUsd:2,maxDailyLossUsd:1,maxSignalAgeMs:2000};
const intent=(over:Partial<Intent>={}):Intent=>({id:1,idempotencyKey:"signal-1",tokenId:"123",marketSlug:"btc-updown",side:"BUY",actionKind:"entry",amount:2,priceLimit:.6,signalCreatedAt:new Date(10_000).toISOString(),expiresAt:new Date(20_000).toISOString(),...over});
test("accepts a fresh capped intent",()=>assert.doesNotThrow(()=>validateIntent(intent(),limits,11_000)));
test("rejects stale signals",()=>assert.throws(()=>validateIntent(intent(),limits,13_000),/stale/));
test("rejects expired intents",()=>assert.throws(()=>validateIntent(intent({expiresAt:new Date(10_500).toISOString()}),limits,11_000),/expired/));
test("rejects invalid price limits",()=>assert.throws(()=>validateIntent(intent({priceLimit:1}),limits,11_000),/price limit/));
test("rejects orders over the hard cap",()=>assert.throws(()=>validateIntent(intent({amount:2.01}),limits,11_000),/maxOrderUsd/));
test("rejects insufficient collateral",()=>assert.throws(()=>assertRiskBudget({intent:intent(),limits,openExposureUsd:0,dailyPnlUsd:0,collateralUsd:0}),/insufficient/));
test("rejects exposure above cap",()=>assert.throws(()=>assertRiskBudget({intent:intent(),limits,openExposureUsd:.01,dailyPnlUsd:0,collateralUsd:9}),/exposure/));
test("rejects at daily loss stop",()=>assert.throws(()=>assertRiskBudget({intent:intent(),limits,openExposureUsd:0,dailyPnlUsd:-1,collateralUsd:9}),/daily loss/));
test("daily loss stop still permits a risk-reducing exit",()=>assert.doesNotThrow(()=>assertRiskBudget({intent:intent({side:"SELL",actionKind:"exit",amount:3}),limits,openExposureUsd:2,dailyPnlUsd:-1,collateralUsd:0})));
test("requires lifecycle-consistent sides",()=>assert.throws(()=>validateIntent(intent({side:"SELL",actionKind:"entry"}),limits,11_000),/must buy/));
test("intent queue is idempotent and transitions atomically",()=>{
  const db=migrate(new DatabaseSync(":memory:")),input={...intent(),id:undefined} as any;
  queueIntent(db,input);queueIntent(db,input);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM intents").get() as any).n,1);
  const queued=nextIntent(db)!;transition(db,queued.id,"queued","submitting");
  assert.equal((db.prepare("SELECT status FROM intents WHERE id=?").get(queued.id) as any).status,"submitting");db.close();
});
test("restart converts interrupted submissions to unknown",()=>{
  const db=migrate(new DatabaseSync(":memory:")),input={...intent(),id:undefined} as any;
  queueIntent(db,input);const queued=nextIntent(db)!;transition(db,queued.id,"queued","submitting");
  assert.equal(recoverInterruptedSubmissions(db),1);
  assert.equal((db.prepare("SELECT status FROM intents WHERE id=?").get(queued.id) as any).status,"unknown");db.close();
});
test("raises an allocation only to the exact market minimum",()=>assert.equal(effectiveBuyAmount(.5,5,.3,2),1.5));
test("rejects a minimum executable allocation above the order cap",()=>assert.throws(()=>effectiveBuyAmount(2.5,5,.3,2),/exceeds maxOrderUsd/));
test("accepts an allocated order that clears all minimums",()=>assert.equal(effectiveBuyAmount(2,5,.3,2),2));
test("accepts an exact minimum-share order despite binary rounding",()=>{
  assert.equal(meetsMinimumShares(1.75/.35,5),true);
  assert.equal(meetsMinimumShares(4.999,5),false);
});
test("maps every V6.1 executable phase",()=>{assert.deepEqual(v61ActionKind("adaptive_value"),{side:"BUY",actionKind:"entry"});assert.deepEqual(v61ActionKind("deterministic_momentum"),{side:"BUY",actionKind:"entry"});assert.deepEqual(v61ActionKind("micro_hedge"),{side:"BUY",actionKind:"hedge"});assert.deepEqual(v61ActionKind("adaptive_exit"),{side:"SELL",actionKind:"exit"});assert.equal(v61ActionKind("observe"),null)});
test("scales paper entries while preserving a one-dollar marketable floor",()=>{assert.equal(scaledLiveBuy(20,.025,1),1);assert.equal(scaledLiveBuy(50,.025,1),1.25)});
test("maps V6.1 stakes to live balance percentages",()=>{assert.equal(v61LiveEntryPercent("adaptive_value",20),10);assert.equal(v61LiveEntryPercent("adaptive_value",35),17.5);assert.equal(v61LiveEntryPercent("deterministic_momentum",50),25);assert.equal(percentageOfCapital(20,17.5),3.5)});
test("adaptive exits liquidate actual wallet inventory",()=>{assert.equal(executableSellShares("exit",100,2.75),2.75);assert.equal(executableSellShares("hedge",1,2.75),1);assert.equal(executableSellShares("exit",100,0),0)});
test("suppresses a hedge when its live entry did not fill",()=>{assert.throws(()=>assertActionDependency("hedge","rejected"),/standalone hedge suppressed/);assert.doesNotThrow(()=>assertActionDependency("hedge","accepted"));assert.doesNotThrow(()=>assertActionDependency("entry"))});
test("accepted buys and exits maintain the live position ledger",()=>{
  const db=migrate(new DatabaseSync(":memory:")),buy={...intent(),id:undefined} as any;queueIntent(db,buy);const queued=nextIntent(db)!;transition(db,queued.id,"queued","submitting");recordAcceptedFill(db,queued,{orderId:"buy-1",status:"matched",makingAmount:"1",takingAmount:"2"});
  const held=db.prepare("SELECT * FROM live_positions WHERE token_id='123'").get() as any;assert.equal(held.shares,2);assert.equal(held.cost_usd,1);
  const sellInput={...intent({idempotencyKey:"signal-2",side:"SELL",actionKind:"exit",amount:2}),id:undefined} as any;queueIntent(db,sellInput);const sell=nextIntent(db)!;transition(db,sell.id,"queued","submitting");recordAcceptedFill(db,sell,{orderId:"sell-1",status:"matched",makingAmount:"2",takingAmount:"0.8"});
  const closed=db.prepare("SELECT * FROM live_positions WHERE token_id='123'").get() as any;assert.equal(closed.shares,0);assert.ok(Math.abs(closed.realized_pnl_usd+0.2)<1e-9);db.close();
});

test("resolved redeemable winners remain capital without consuming exposure",()=>{
  const totals=portfolioTotals([
    {initialValue:"7.95",currentValue:"0",redeemable:true},
    {initialValue:"3.20",currentValue:"5.00",redeemable:true},
    {initialValue:"2.50",currentValue:"2.70",redeemable:false},
  ]);
  assert.deepEqual(totals,{openExposureUsd:2.5,currentValueUsd:7.7});
});
