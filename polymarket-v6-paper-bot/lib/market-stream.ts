export type StreamLevel={price:string;size:string};
export type StreamBook={bids:StreamLevel[];asks:StreamLevel[];last_trade_price?:string};
export type RawMarketFrame=Record<string,unknown>;

export function hasUsableAskDepth(book:StreamBook|undefined):book is StreamBook{
  return Boolean(book?.asks.some(level=>Number(level.price)>0&&Number(level.price)<1&&Number(level.size)>0));
}

export function parseMarketFrames(raw:string):RawMarketFrame[]{
  if(raw==="PONG"||raw==="PING"||!raw.trim())return [];
  const parsed=JSON.parse(raw) as unknown;
  return (Array.isArray(parsed)?parsed:[parsed]).filter((value):value is RawMarketFrame=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value));
}

function tokenId(value:RawMarketFrame){return String(value.asset_id||value.assetId||value.token_id||value.tokenId||"")}
function replaceLevel(levels:StreamLevel[],price:string,size:string,descending:boolean){
  const numericPrice=Number(price),numericSize=Number(size);
  if(!Number.isFinite(numericPrice)||numericPrice<=0||numericPrice>=1||!Number.isFinite(numericSize)||numericSize<0)return levels;
  const next=levels.filter(level=>Number(level.price)!==numericPrice);
  if(numericSize>0)next.push({price:String(price),size:String(size)});
  return next.sort((left,right)=>descending?Number(right.price)-Number(left.price):Number(left.price)-Number(right.price));
}

export function applyMarketFrame(books:Map<string,StreamBook>,frame:RawMarketFrame){
  const eventType=String(frame.event_type||frame.type||"");
  const changed:string[]=[];
  if(eventType==="book"){
    const id=tokenId(frame);if(!id)return changed;
    books.set(id,{bids:Array.isArray(frame.bids)?frame.bids as StreamLevel[]:[],asks:Array.isArray(frame.asks)?frame.asks as StreamLevel[]:[],last_trade_price:frame.last_trade_price?String(frame.last_trade_price):undefined});
    changed.push(id);
  }else if(eventType==="price_change"){
    const changes=(frame.price_changes||frame.priceChanges) as RawMarketFrame[]|undefined;
    for(const change of changes||[]){
      const id=tokenId(change),book=books.get(id);if(!id||!book)continue;
      const price=String(change.price||""),size=String(change.size??""),side=String(change.side||"").toUpperCase();
      if(side==="BUY")book.bids=replaceLevel(book.bids,price,size,true);
      else if(side==="SELL")book.asks=replaceLevel(book.asks,price,size,false);
      else continue;
      changed.push(id);
    }
  }else if(eventType==="last_trade_price"){
    const id=tokenId(frame),book=books.get(id);if(id&&book&&frame.price!=null)book.last_trade_price=String(frame.price);
  }
  return [...new Set(changed)];
}

export function marketFrameTimestamp(frame:RawMarketFrame){
  const raw=frame.timestamp;
  if(raw==null)return null;
  const numeric=Number(raw);if(Number.isFinite(numeric))return numeric;
  const parsed=Date.parse(String(raw));return Number.isFinite(parsed)?parsed:null;
}
