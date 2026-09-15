export type MonitorWallet={address:string;global_score:number;category:string};

export function normalizeCopyProfile(value:string|undefined){
  if(!value)return null;
  const address=value.toLowerCase();
  if(!/^0x[a-f0-9]{40}$/.test(address))throw new Error("COPY_PROFILE must be a complete 0x wallet address");
  return address;
}

export function selectMonitorWallets(configured:string|undefined,fallback:MonitorWallet[]):MonitorWallet[]{
  const address=normalizeCopyProfile(configured);
  return address?[{address,global_score:100,category:"BTC 5m"}]:fallback;
}

export function copyActivityCutoff(unixNow:number,accountCreatedAt:string|undefined){
  const accountStart=accountCreatedAt?Math.floor(Date.parse(accountCreatedAt)/1000):0;
  return Math.max(unixNow-3*60,Number.isFinite(accountStart)?accountStart:0);
}
