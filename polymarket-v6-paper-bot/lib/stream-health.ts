export type DisplayStreamStatus="connected"|"reconnecting"|"offline"|"stopped"|"starting";

export function displayStreamStatus(state:{status?:string;updated_at?:string}|undefined,now=Date.now(),staleAfterMs=15_000):DisplayStreamStatus{
  if(!state)return "starting";
  if(state.status==="stopped")return "stopped";
  const updated=Date.parse(state.updated_at||"");
  if(!Number.isFinite(updated)||now-updated>staleAfterMs)return "offline";
  return state.status==="connected"?"connected":"reconnecting";
}

export function streamStatusLabel(status:DisplayStreamStatus){
  if(status==="connected")return "POLYMARKET + CHAINLINK + BINANCE LIVE";
  if(status==="reconnecting")return "FEEDS RECONNECTING";
  if(status==="stopped")return "ENGINE STOPPED";
  if(status==="offline")return "ENGINE OFFLINE · HEARTBEAT STALE";
  return "ENGINE STARTING";
}
