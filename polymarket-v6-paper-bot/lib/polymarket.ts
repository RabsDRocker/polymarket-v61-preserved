const DATA = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const CLOB = process.env.POLYMARKET_CLOB_API || "https://clob.polymarket.com";
const GAMMA = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "codex-paper-copy-research/1.0" } });
  if (!response.ok) throw new Error(`Polymarket ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export type Leader = { proxyWallet?: string; userAddress?: string; userName?: string; name?: string; pnl?: number; vol?: number; volume?: number };
export type Activity = { proxyWallet?: string; asset?: string; conditionId?: string; transactionHash?: string; title?: string; side?: string; size?: number; usdcSize?: number; price?: number; timestamp?: number; slug?: string; eventSlug?: string; outcome?: string };
export type ClosedPosition = { proxyWallet?: string; asset?: string; conditionId?: string; title?: string; slug?: string; eventSlug?: string; outcome?: string; avgPrice?: number; totalBought?: number; realizedPnl?: number; cashPnl?: number; endDate?: string };
export type PublicPosition = { asset:string;size:number;avgPrice:number;initialValue:number;currentValue:number;curPrice:number;title:string;slug:string;eventSlug?:string;outcome:string;redeemable?:boolean };

export const isBtc5mMarket = (item: { slug?: string; eventSlug?: string; title?: string }) => {
  const slug = `${item.slug || ""} ${item.eventSlug || ""}`.toLowerCase();
  const title = (item.title || "").toLowerCase();
  return slug.includes("btc-updown-5m-") || (title.includes("bitcoin up or down") && /5\s*min|5-minute|:\d{2}\s*-\s*\d{1,2}:\d{2}/i.test(title));
};

export type ShortCryptoSpec={asset:"BTC"|"ETH";minutes:5|15;start:number;slug:string};
export function parseShortCryptoMarket(item:{slug?:string;eventSlug?:string;title?:string}):ShortCryptoSpec|null{
  const slug=(item.eventSlug||item.slug||"").toLowerCase();
  const match=slug.match(/^(btc|eth)-updown-(5m|15m)-(\d+)$/); if(match) return {asset:match[1].toUpperCase() as "BTC"|"ETH",minutes:match[2]==="5m"?5:15,start:Number(match[3]),slug};
  return null;
}
export const isSupportedShortCryptoMarket=(item:{slug?:string;eventSlug?:string;title?:string})=>parseShortCryptoMarket(item)!==null;

export async function fetchLeaderboard(limit = 100): Promise<Leader[]> {
  const configured = process.env.POLYMARKET_LEADERBOARD_URL;
  if (configured) { const data = await getJson<Leader[] | { data: Leader[] }>(configured); return Array.isArray(data) ? data : data.data; }
  const leaders: Leader[] = [];
  for (let offset = 0; offset < Math.min(limit, 500); offset += 50) {
    const batch = await getJson<Leader[]>(`${DATA}/v1/leaderboard?category=CRYPTO&timePeriod=MONTH&orderBy=VOL&limit=${Math.min(50, limit - offset)}&offset=${offset}`);
    leaders.push(...batch);
    if (batch.length < 50) break;
  }
  return leaders;
}

export async function fetchActivity(address: string, limit = 100): Promise<Activity[]> {
  return getJson<Activity[]>(`${DATA}/activity?user=${encodeURIComponent(address)}&limit=${limit}&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC`);
}

export async function fetchPortfolioValue(address:string):Promise<number> {
  const rows=await getJson<{user:string;value:number}[]>(`${DATA}/value?user=${encodeURIComponent(address)}`);
  const value=Number(rows[0]?.value||0);if(value<=0)throw new Error(`Polymarket portfolio value was unavailable for ${address}`);return value;
}

export async function fetchPositions(address:string):Promise<PublicPosition[]> {
  return getJson<PublicPosition[]>(`${DATA}/positions?user=${encodeURIComponent(address)}&sizeThreshold=0&limit=500`);
}

export async function fetchClosedPositions(address: string, limit = 500): Promise<ClosedPosition[]> {
  return getJson<ClosedPosition[]>(`${DATA}/closed-positions?user=${encodeURIComponent(address)}&limit=${Math.min(limit, 500)}`);
}

export async function fetchBook(tokenId: string) {
  return getJson<{ bids: { price: string; size: string }[]; asks: { price: string; size: string }[]; last_trade_price?: string }>(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}

export async function fetchEventBySlug(slug: string) {
  return getJson<{ title?:string; closed?: boolean; markets?: { closed?: boolean; outcomes?: string; outcomePrices?: string; clobTokenIds?: string }[] }>(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
}

export function summarizeBook(book: Awaited<ReturnType<typeof fetchBook>>) {
  const bid = Math.max(...book.bids.map(x => Number(x.price)), 0);
  const ask = Math.min(...book.asks.map(x => Number(x.price)), 1);
  const liquidity = [...book.bids, ...book.asks].reduce((sum, x) => sum + Number(x.price) * Number(x.size), 0);
  return { price: Number(book.last_trade_price || ((bid + ask) / 2)), bid, ask, spread: Math.max(0, ask - bid), liquidity };
}

export function executablePositionMark(book:Awaited<ReturnType<typeof fetchBook>>) {
  return summarizeBook(book).bid;
}


export async function fetchCryptoReferencePrices(timeoutMs=10000):Promise<{BTC:number;ETH:number;observedAt:number}> {
  return new Promise((resolve,reject)=>{
    const prices:Partial<{BTC:number;ETH:number}>={}; const socket=new WebSocket("wss://ws-live-data.polymarket.com");
    const timer=setTimeout(()=>{socket.close();reject(new Error("Polymarket RTDS reference-price timeout"))},timeoutMs);
    socket.addEventListener("open",()=>socket.send(JSON.stringify({action:"subscribe",subscriptions:[{topic:"crypto_prices_chainlink",type:"update"}]})));
    socket.addEventListener("message",event=>{if(event.data==="PONG")return;try{const message=JSON.parse(String(event.data)),payload=message.payload||{};const symbol=String(payload.symbol||"").toLowerCase(),value=Number(payload.value);if(symbol==="btc/usd")prices.BTC=value;if(symbol==="eth/usd")prices.ETH=value;if(prices.BTC&&prices.ETH){clearTimeout(timer);socket.close();resolve({BTC:prices.BTC,ETH:prices.ETH,observedAt:Number(payload.timestamp||Date.now())})}}catch{}});
    socket.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("Polymarket RTDS reference-price connection failed"))});
  });
}
