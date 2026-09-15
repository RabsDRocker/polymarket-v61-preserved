import { spawnSync } from "node:child_process";

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let running=true;
let cycleNumber=0;
process.on("SIGINT",()=>{running=false});
process.on("SIGTERM",()=>{running=false});

while(running) {
  const commands=process.env.BOT_VERSION==="v5"?["paper:scan:v5",...(cycleNumber%6===0?["report:daily"]:[])]:process.env.COPY_PROFILE?["monitor:trades","review:outcomes","report:daily"]:process.env.MARKET_MODE==="btc5"?["paper:final-minute","monitor:trades","review:outcomes","report:daily"]:["monitor:trades","review:outcomes","report:daily"];
  for(const command of commands) {
    const result=spawnSync("pnpm",["run",command],{stdio:"inherit",env:{...process.env,TRADING_MODE:"paper"}});
    if(result.status!==0) {
      console.error(`Paper command ${command} failed; backing off for 60 seconds before retrying.`);
      await delay(60_000); break;
    }
  }
  cycleNumber++;
  if(running) await delay(10_000);
}
console.log("Continuous paper mirror stopped.");
