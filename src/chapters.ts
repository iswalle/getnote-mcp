// Derive only from the immediate next valid chapter. Never guess audio units.
export function chapterEndTimes<T>(value:T):T {
 if(!value||typeof value!=='object')return value;
 const timeline=value as Record<string,unknown>;
 if(!Array.isArray(timeline.items))return value;
 const items=timeline.items.map(item=>item&&typeof item==='object'?{...item}:item);
 for(let i=0;i<items.length;i++){
  const item=items[i];if(!item||typeof item!=='object'||'end_ms' in item)continue;
  item.end_ms=null;
  const start=item.start_ms,next=items[i+1]?.start_ms;
  if(Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(next)&&next>start){item.end_ms=next;item.end_source='next_chapter_start'}
 }
 return {...timeline,items} as T;
}
