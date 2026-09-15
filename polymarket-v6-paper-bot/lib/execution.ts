type Level={price:string;size:string};
type Book={bids:Level[];asks:Level[]};

export function cryptoTakerFee(shares:number,price:number,rate=.07){return Math.round(shares*rate*price*(1-price)*100000)/100000}

export function simulateBuy(book:Book,budget:number){
  let remaining=budget,shares=0,gross=0,fee=0;
  for(const level of [...book.asks].sort((a,b)=>Number(a.price)-Number(b.price))){
    const price=Number(level.price),available=Number(level.size); if(price<=0||price>=1||available<=0) continue;
    const unitCost=price+.07*price*(1-price),take=Math.min(available,remaining/unitCost); if(take<=0) break;
    const levelGross=take*price,levelFee=cryptoTakerFee(take,price); shares+=take;gross+=levelGross;fee+=levelFee;remaining-=levelGross+levelFee;
  }
  const spent=gross+fee; return {shares,avgPrice:shares?gross/shares:0,gross,fee,spent,fillRatio:budget?spent/budget:0};
}

export function simulateSell(book:Book,requestedShares:number){
  let remaining=requestedShares,shares=0,gross=0,fee=0;
  for(const level of [...book.bids].sort((a,b)=>Number(b.price)-Number(a.price))){
    const price=Number(level.price),available=Number(level.size),take=Math.min(available,remaining); if(price<=0||price>=1||take<=0) continue;
    const levelGross=take*price,levelFee=cryptoTakerFee(take,price);shares+=take;gross+=levelGross;fee+=levelFee;remaining-=take;if(remaining<=1e-9)break;
  }
  return {shares,avgPrice:shares?gross/shares:0,gross,fee,proceeds:gross-fee,fillRatio:requestedShares?shares/requestedShares:0};
}
