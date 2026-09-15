import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "paperbot.db");

export function openDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  return db;
}

export function migrate() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY, label TEXT, category TEXT, pnl REAL NOT NULL,
      volume REAL NOT NULL, trades INTEGER NOT NULL, resolved_trades INTEGER NOT NULL,
      wins INTEGER NOT NULL, largest_trade_pnl REAL NOT NULL, average_liquidity REAL NOT NULL,
      average_spread REAL NOT NULL, average_price_move REAL NOT NULL,
      roi_score REAL NOT NULL, consistency_score REAL NOT NULL, copyability_score REAL NOT NULL,
      one_hit_penalty REAL NOT NULL, global_score REAL NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, market TEXT NOT NULL,
      category TEXT NOT NULL, side TEXT NOT NULL, token_id TEXT NOT NULL,
      market_slug TEXT, outcome TEXT,
      wallet_entry REAL NOT NULL, current_price REAL NOT NULL, spread REAL NOT NULL,
      liquidity REAL NOT NULL, score REAL NOT NULL, decision TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(wallet, token_id, wallet_entry)
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id INTEGER NOT NULL UNIQUE,
      entry_price REAL NOT NULL, current_price REAL NOT NULL, size REAL NOT NULL,
      pnl REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', opened_at TEXT NOT NULL,
      closed_at TEXT, FOREIGN KEY(signal_id) REFERENCES signals(id)
    );
    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, paper_trade_id INTEGER NOT NULL,
      price REAL NOT NULL, pnl REAL NOT NULL, captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rule_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER UNIQUE NOT NULL, active INTEGER NOT NULL,
      rules_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_date TEXT UNIQUE NOT NULL,
      summary TEXT NOT NULL, sent_to_telegram INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_accounts (
      id INTEGER PRIMARY KEY CHECK(id=1), starting_balance REAL NOT NULL,
      strategy TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS funding_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL NOT NULL,
      balance_after REAL NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS copy_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
      wallet TEXT NOT NULL, market TEXT NOT NULL, market_slug TEXT NOT NULL,
      token_id TEXT NOT NULL, outcome TEXT, side TEXT NOT NULL,
      source_size REAL NOT NULL, source_usdc REAL NOT NULL, source_price REAL NOT NULL,
      market_price REAL NOT NULL, paper_dollars REAL NOT NULL, paper_shares REAL NOT NULL,
      decision TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_positions_v2 (
      token_id TEXT PRIMARY KEY, wallet TEXT NOT NULL, market TEXT NOT NULL,
      market_slug TEXT NOT NULL, outcome TEXT, shares REAL NOT NULL,
      cost_basis REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0,
      current_price REAL NOT NULL, status TEXT NOT NULL, opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS account_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, equity REAL NOT NULL, available_cash REAL NOT NULL,
      deployed REAL NOT NULL, realized_pnl REAL NOT NULL, unrealized_pnl REAL NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mirror_state (
      id INTEGER PRIMARY KEY CHECK(id=1), profile_value REAL NOT NULL,
      copy_ratio REAL NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_references (
      market_slug TEXT PRIMARY KEY, asset TEXT NOT NULL, minutes INTEGER NOT NULL,
      start_ts INTEGER NOT NULL, target_price REAL, target_captured_at TEXT,
      target_delay_seconds REAL, current_price REAL, current_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sweeper_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_slug TEXT NOT NULL, token_id TEXT NOT NULL,
      asset TEXT NOT NULL, outcome TEXT NOT NULL, target_price REAL NOT NULL,current_price REAL NOT NULL,
      gap_pct REAL NOT NULL, requested_dollars REAL NOT NULL, filled_dollars REAL NOT NULL,
      shares REAL NOT NULL, avg_price REAL NOT NULL, fee_usdc REAL NOT NULL,decision TEXT NOT NULL,
      reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(market_slug,token_id)
    );
    CREATE TABLE IF NOT EXISTS v5_opportunities (
      market_slug TEXT PRIMARY KEY, market TEXT NOT NULL, asset TEXT NOT NULL,
      minutes INTEGER NOT NULL, up_token_id TEXT NOT NULL, down_token_id TEXT NOT NULL,
      up_ask REAL NOT NULL, down_ask REAL NOT NULL, raw_ask_sum REAL NOT NULL,
      pairs REAL NOT NULL, gross_cost REAL NOT NULL, fee_usdc REAL NOT NULL,
      execution_reserve REAL NOT NULL, conservative_cost REAL NOT NULL,
      locked_profit REAL NOT NULL, net_edge_per_pair REAL NOT NULL,
      decision TEXT NOT NULL, reason TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, filled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS v5_daily_stats (
      report_date TEXT PRIMARY KEY, scans INTEGER NOT NULL DEFAULT 0,
      opportunities INTEGER NOT NULL DEFAULT 0, fills INTEGER NOT NULL DEFAULT 0,
      locked_profit REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v5_stream_state (
      id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'websocket', connected_at TEXT,
      last_message_at TEXT, messages INTEGER NOT NULL DEFAULT 0,
      reconnects INTEGER NOT NULL DEFAULT 0, subscribed_tokens INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ha_account (
      id INTEGER PRIMARY KEY CHECK(id=1), starting_balance REAL NOT NULL,
      strategy TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ha_rule_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER UNIQUE NOT NULL,
      active INTEGER NOT NULL, rules_json TEXT NOT NULL, reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ha_markets (
      market_slug TEXT PRIMARY KEY, market TEXT NOT NULL, asset TEXT NOT NULL,
      minutes INTEGER NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
      up_token_id TEXT NOT NULL, down_token_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ha_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
      market_slug TEXT NOT NULL, market TEXT NOT NULL, phase TEXT NOT NULL,
      tier TEXT, token_id TEXT NOT NULL, outcome TEXT NOT NULL,
      probability REAL NOT NULL, requested_dollars REAL NOT NULL,
      filled_dollars REAL NOT NULL, shares REAL NOT NULL, avg_price REAL NOT NULL,
      fee_usdc REAL NOT NULL, fill_ratio REAL NOT NULL, decision TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ha_positions (
      token_id TEXT PRIMARY KEY, market_slug TEXT NOT NULL, market TEXT NOT NULL,
      outcome TEXT NOT NULL, shares REAL NOT NULL, cost_basis REAL NOT NULL,
      current_price REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open', opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ha_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, equity REAL NOT NULL,
      available_cash REAL NOT NULL, deployed REAL NOT NULL,
      realized_pnl REAL NOT NULL, unrealized_pnl REAL NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ha_reports (
      report_date TEXT PRIMARY KEY, summary TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pv_account (id INTEGER PRIMARY KEY CHECK(id=1),starting_balance REAL NOT NULL,strategy TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pv_markets (market_slug TEXT PRIMARY KEY,market TEXT NOT NULL,asset TEXT NOT NULL,minutes INTEGER NOT NULL,start_ts INTEGER NOT NULL,end_ts INTEGER NOT NULL,up_token_id TEXT NOT NULL,down_token_id TEXT NOT NULL,target_price REAL,target_captured_at TEXT,target_delay_seconds REAL,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pv_events (id INTEGER PRIMARY KEY AUTOINCREMENT,market_slug TEXT UNIQUE NOT NULL,market TEXT NOT NULL,asset TEXT NOT NULL,minutes INTEGER NOT NULL,outcome TEXT,target_price REAL,spot_price REAL,seconds_remaining REAL,volatility REAL,fair_probability REAL,market_ask REAL,net_edge REAL,requested_dollars REAL NOT NULL DEFAULT 0,filled_dollars REAL NOT NULL DEFAULT 0,shares REAL NOT NULL DEFAULT 0,avg_price REAL NOT NULL DEFAULT 0,fee_usdc REAL NOT NULL DEFAULT 0,fill_ratio REAL NOT NULL DEFAULT 0,decision TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pv_positions (token_id TEXT PRIMARY KEY,market_slug TEXT NOT NULL,market TEXT NOT NULL,asset TEXT NOT NULL,minutes INTEGER NOT NULL,outcome TEXT NOT NULL,shares REAL NOT NULL,cost_basis REAL NOT NULL,current_price REAL NOT NULL,realized_pnl REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'open',opened_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT);
    CREATE TABLE IF NOT EXISTS pv_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT,equity REAL NOT NULL,available_cash REAL NOT NULL,deployed REAL NOT NULL,realized_pnl REAL NOT NULL,unrealized_pnl REAL NOT NULL,captured_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pv_stream_state (id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,market_connected INTEGER NOT NULL DEFAULT 0,spot_connected INTEGER NOT NULL DEFAULT 0,last_market_message_at TEXT,last_spot_message_at TEXT,subscribed_tokens INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at TEXT NOT NULL);
  `);
  const signalColumns = new Set((db.prepare("PRAGMA table_info(signals)").all() as {name:string}[]).map(column => column.name));
  if (!signalColumns.has("market_slug")) db.exec("ALTER TABLE signals ADD COLUMN market_slug TEXT");
  if (!signalColumns.has("outcome")) db.exec("ALTER TABLE signals ADD COLUMN outcome TEXT");
  const copyColumns=new Set((db.prepare("PRAGMA table_info(copy_events)").all() as {name:string}[]).map(column=>column.name));
  for(const [name,type] of [["source_timestamp","INTEGER"],["detected_at","TEXT"],["latency_ms","INTEGER"],["requested_dollars","REAL NOT NULL DEFAULT 0"],["fill_ratio","REAL NOT NULL DEFAULT 0"],["fee_usdc","REAL NOT NULL DEFAULT 0"],["strategy","TEXT NOT NULL DEFAULT 'copy'"]] as const) if(!copyColumns.has(name)) db.exec(`ALTER TABLE copy_events ADD COLUMN ${name} ${type}`);
  const v5Columns=new Set((db.prepare("PRAGMA table_info(v5_opportunities)").all() as {name:string}[]).map(column=>column.name));
  for(const [name,type] of [["transport","TEXT NOT NULL DEFAULT 'rest'"],["source_timestamp_ms","INTEGER"],["evaluation_latency_ms","REAL"],["book_updates","INTEGER NOT NULL DEFAULT 0"]] as const)if(!v5Columns.has(name))db.exec(`ALTER TABLE v5_opportunities ADD COLUMN ${name} ${type}`);
  db.close();
}

export function queryAll<T>(sql: string, params: SQLInputValue[] = []): T[] {
  migrate(); const db = openDb();
  try { return db.prepare(sql).all(...params) as T[]; } finally { db.close(); }
}
