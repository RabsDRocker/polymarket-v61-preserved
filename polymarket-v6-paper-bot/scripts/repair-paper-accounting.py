import sqlite3,json,datetime,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
assert not c.execute("select 1 from sqlite_master where name='accounting_repairs'").fetchone(),'Already repaired'
states={};events=[]
for r in c.execute('select * from actions order by id'):
 s=states.setdefault((r['slug'],r['outcome']),dict(shares=0.,cost=0.,realized=0.,legacy=0.,buys=0))
 if r['phase']=='adaptive_exit':
  assert abs(r['shares']-s['shares'])<1e-6,('Historical partial sale',r['id'])
  pnl=r['spent']-s['cost'];s['realized']+=pnl;s['legacy']+=pnl;s['shares']=0.;s['cost']=0.
 else:
  assert s['shares']<1e-8,('Overlapping buys',r['id'])
  if s['buys'] and abs(s['legacy'])>1e-9:events.append((r['created_at'],s['legacy'],r['id']))
  s.update(legacy=0.,shares=r['shares'],cost=r['spent'],buys=s['buys']+1)
changes=[]
for p in c.execute('select * from positions'):
 s=states[(p['slug'],p['outcome'])];expected=s['realized'];legacy=s['legacy']
 if p['status'] in ('won','lost'):
  settlement=(s['shares'] if p['status']=='won' else 0)-s['cost'];expected+=settlement;legacy+=settlement
 elif p['status']=='open':assert abs(s['shares']-p['shares'])<1e-6 and abs(s['cost']-p['cost'])<1e-6
 else:assert s['shares']<1e-6
 assert abs(legacy-p['realized_pnl'])<1e-6,('Unexpected accounting',p['token'])
 if abs(expected-p['realized_pnl'])>1e-8:changes.append((expected,p['token'],expected-p['realized_pnl']))
assert abs(sum(z[2] for z in changes)-sum(z[1] for z in events))<1e-6
c.execute('BEGIN IMMEDIATE')
for expected,token,delta in changes:c.execute('update positions set realized_pnl=? where token=?',(expected,token))
for stamp,delta,aid in events:c.execute('update snapshots set equity=equity+?,available_cash=available_cash+?,realized_pnl=realized_pnl+? where captured_at>=?',(delta,delta,delta,stamp))
c.execute('create table accounting_repairs(id integer primary key,applied_at text,details text)')
details=dict(changed_positions=len(changes),realized_correction=sum(z[2] for z in changes),events=events)
stamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
c.execute('insert into accounting_repairs(applied_at,details) values(?,?)',(stamp,json.dumps(details)))
start=c.execute('select starting_balance from account').fetchone()[0];ps=list(c.execute('select * from positions'));realized=sum(p['realized_pnl'] for p in ps);deployed=sum(p['cost'] for p in ps if p['status']=='open');unreal=sum(p['shares']*p['current_price']-p['cost'] for p in ps if p['status']=='open')
c.execute('insert into snapshots(equity,available_cash,deployed,realized_pnl,unrealized_pnl,captured_at) values(?,?,?,?,?,?)',(start+realized+unreal,start+realized-deployed,deployed,realized,unreal,stamp))
c.commit();print(json.dumps(dict(**details,equity=start+realized+unreal,cash=start+realized-deployed,realized=realized,integrity=c.execute('pragma integrity_check').fetchone()[0])))
