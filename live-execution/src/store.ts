import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {Intent, Side} from "./core.ts";

export const STATE_DIR = process.env.LIVE_STATE_DIR || "/var/lib/polymarket-live";
export const DB_PATH = process.env.LIVE_DB_PATH || path.join(STATE_DIR, "execution.db");
export const KILL_FILE = process.env.LIVE_KILL_FILE || path.join(STATE_DIR, "KILL_SWITCH");

export function openStore() {
  fs.mkdirSync(STATE_DIR, {recursive: true, mode: 0o750});
  const db = new DatabaseSync(DB_PATH);
  // The signal bridge and executor share this WAL database. Wait for short
  // writer collisions instead of surfacing SQLITE_BUSY as a fatal error.
  db.exec("PRAGMA busy_timeout=10000");
  return db;
}

export function migrate(db = openStore()) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      token_id TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
      action_kind TEXT NOT NULL DEFAULT 'entry' CHECK(action_kind IN ('entry','hedge','exit')),
      amount REAL NOT NULL CHECK(amount>0),
      price_limit REAL NOT NULL CHECK(price_limit>0 AND price_limit<1),
      signal_created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      exchange_order_id TEXT,
      exchange_status TEXT,
      filled_usd REAL NOT NULL DEFAULT 0,
      filled_shares REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exchange_orders(
      order_id TEXT PRIMARY KEY,
      intent_id INTEGER,
      status TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY(intent_id) REFERENCES intents(id)
    );
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_positions(
      token_id TEXT PRIMARY KEY,
      shares REAL NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO settings(key,value) VALUES
      ('kill_switch','engaged'),
      ('open_exposure_usd','0'),
      ('daily_pnl_usd','0');
  `);
  const columns=(db.prepare("PRAGMA table_info(intents)").all() as any[]).map(row=>row.name);
  if(!columns.includes("action_kind"))db.exec("ALTER TABLE intents ADD COLUMN action_kind TEXT NOT NULL DEFAULT 'entry'");
  if(!columns.includes("filled_usd"))db.exec("ALTER TABLE intents ADD COLUMN filled_usd REAL NOT NULL DEFAULT 0");
  if(!columns.includes("filled_shares"))db.exec("ALTER TABLE intents ADD COLUMN filled_shares REAL NOT NULL DEFAULT 0");
  return db;
}

export function queueIntent(db: DatabaseSync, input: Omit<Intent,"id">) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO intents(idempotency_key,token_id,market_slug,side,action_kind,amount,price_limit,signal_created_at,expires_at,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?, 'queued',?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(
      input.idempotencyKey,input.tokenId,input.marketSlug,input.side,input.actionKind,input.amount,input.priceLimit,input.signalCreatedAt,input.expiresAt,now,now);
}

export function nextIntent(db: DatabaseSync): Intent | null {
  const row = db.prepare("SELECT * FROM intents WHERE status='queued' ORDER BY id LIMIT 1").get() as any;
  if (!row) return null;
  return {id:row.id,idempotencyKey:row.idempotency_key,tokenId:row.token_id,marketSlug:row.market_slug,side:row.side as Side,actionKind:row.action_kind,amount:row.amount,priceLimit:row.price_limit,signalCreatedAt:row.signal_created_at,expiresAt:row.expires_at};
}

export function transition(db: DatabaseSync, id: number, from: string, to: string, detail?: string) {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result=db.prepare("UPDATE intents SET status=?,error=?,updated_at=? WHERE id=? AND status=?").run(to,detail||null,now,id,from);
    if (result.changes !== 1) throw new Error(`intent ${id} transition ${from}->${to} rejected`);
    db.prepare("INSERT INTO events(intent_id,event,detail,created_at) VALUES(?,?,?,?)").run(id,to,detail||null,now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function setting(db: DatabaseSync, key: string) {
  return String((db.prepare("SELECT value FROM settings WHERE key=?").get(key) as any)?.value ?? "");
}

export function setSetting(db: DatabaseSync, key: string, value: string) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value);
}

export function killed(db: DatabaseSync) { return fs.existsSync(KILL_FILE) || setting(db,"kill_switch") !== "disengaged"; }

export function recoverInterruptedSubmissions(db: DatabaseSync) {
  const now=new Date().toISOString();
  const result=db.prepare("UPDATE intents SET status='unknown',error='process stopped during submission; manual reconciliation required',updated_at=? WHERE status='submitting'").run(now);
  return Number(result.changes);
}

export function recordAcceptedFill(db:DatabaseSync,intent:Intent,response:{orderId:string;status:string;makingAmount:number|string;takingAmount:number|string}){
  const making=Number(response.makingAmount),taking=Number(response.takingAmount),stamp=new Date().toISOString();
  if(!Number.isFinite(making)||making<0||!Number.isFinite(taking)||taking<0)throw new Error("invalid exchange fill amounts");
  const filledUsd=intent.side==="BUY"?making:taking,filledShares=intent.side==="BUY"?taking:making;
  db.exec("BEGIN IMMEDIATE");
  try{
    const moved=db.prepare("UPDATE intents SET status='accepted',exchange_order_id=?,exchange_status=?,filled_usd=?,filled_shares=?,updated_at=? WHERE id=? AND status='submitting'").run(response.orderId,response.status,filledUsd,filledShares,stamp,intent.id);
    if(moved.changes!==1)throw new Error("accepted fill transition rejected");
    const prior=db.prepare("SELECT shares,cost_usd,realized_pnl_usd FROM live_positions WHERE token_id=?").get(intent.tokenId) as any;
    const oldShares=Number(prior?.shares||0),oldCost=Number(prior?.cost_usd||0),oldRealized=Number(prior?.realized_pnl_usd||0);
    if(intent.side==="BUY"){
      db.prepare("INSERT INTO live_positions(token_id,shares,cost_usd,realized_pnl_usd,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET shares=excluded.shares,cost_usd=excluded.cost_usd,realized_pnl_usd=excluded.realized_pnl_usd,updated_at=excluded.updated_at").run(intent.tokenId,oldShares+filledShares,oldCost+filledUsd,oldRealized,stamp);
    }else{
      const sold=Math.min(oldShares,filledShares),removedCost=oldShares>0?oldCost*(sold/oldShares):0,realized=filledUsd-removedCost;
      db.prepare("INSERT INTO live_positions(token_id,shares,cost_usd,realized_pnl_usd,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET shares=excluded.shares,cost_usd=excluded.cost_usd,realized_pnl_usd=excluded.realized_pnl_usd,updated_at=excluded.updated_at").run(intent.tokenId,Math.max(0,oldShares-sold),Math.max(0,oldCost-removedCost),oldRealized+realized,stamp);
    }
    db.exec("COMMIT");return {filledUsd,filledShares};
  }catch(error){db.exec("ROLLBACK");throw error;}
}
