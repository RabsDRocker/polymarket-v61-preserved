import fs from "node:fs";
import {createExchange,publicPreflight} from "./sdk.ts";
import {DB_PATH,KILL_FILE,killed,migrate,openStore,setting} from "./store.ts";

const command=process.argv[2]||"status",db=migrate(openStore());
if(command==="migrate") console.log(JSON.stringify({ok:true,db:DB_PATH,killSwitch:KILL_FILE}));
else if(command==="status"){
  const counts=Object.fromEntries(["queued","submitting","accepted","rejected","unknown"].map(status=>[status,(db.prepare("SELECT COUNT(*) n FROM intents WHERE status=?").get(status) as any).n]));
  console.log(JSON.stringify({killSwitch:killed(db)?"engaged":"disengaged",killFile:fs.existsSync(KILL_FILE),liveEnabled:process.env.LIVE_TRADING_ENABLED==="I_UNDERSTAND_REAL_ORDERS",credentialsConfigured:Boolean(process.env.POLYMARKET_PRIVATE_KEY&&process.env.POLYMARKET_WALLET_ADDRESS),openExposureUsd:Number(setting(db,"open_exposure_usd")||0),dailyPnlUsd:Number(setting(db,"daily_pnl_usd")||0),intents:counts},null,2));
}else if(command==="check"){
  const geo=await publicPreflight(); console.log(JSON.stringify({geoblock:geo,node:process.version,killSwitch:killed(db)?"engaged":"disengaged",credentialsConfigured:Boolean(process.env.POLYMARKET_PRIVATE_KEY&&process.env.POLYMARKET_WALLET_ADDRESS)},null,2));
}else if(command==="auth-check"){
  const exchange=await createExchange();
  try{const [geo,collateral,exposure,orders]=await Promise.all([exchange.geoblock(),exchange.collateralUsd(),exchange.openExposureUsd(),exchange.openOrders()]);console.log(JSON.stringify({geoblock:geo,collateralUsd:collateral,openExposureUsd:exposure,openOrders:orders.length},null,2));}
  finally{await exchange.close();}
}else throw new Error(`unknown command ${command}`);
db.close();
