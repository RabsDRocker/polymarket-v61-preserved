export const finalMinuteProbabilityPolicy={seconds:60,minimumProbability:.80,dollarsPerBuy:25} as const;

export function decideFinalMinuteProbability(input:{secondsRemaining:number;probabilities:{outcome:string;probability:number}[]}) {
  if(input.secondsRemaining<=0||input.secondsRemaining>finalMinuteProbabilityPolicy.seconds) return {action:"wait" as const,outcome:null,probability:0};
  const leader=[...input.probabilities].filter(item=>Number.isFinite(item.probability)).sort((a,b)=>b.probability-a.probability)[0];
  if(!leader||leader.probability<=finalMinuteProbabilityPolicy.minimumProbability) return {action:"below_threshold" as const,outcome:null,probability:leader?.probability||0};
  return {action:"trade" as const,outcome:leader.outcome,probability:leader.probability};
}
