import fs from 'node:fs';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const u='https://scumsa.com/servers/202.189.7.201-12102/1177-11-1-pvp5-8555';
const r=await fetch(u,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(25000)});
const t=await r.text();
fs.writeFileSync('tmp-scumsa2.html',t);
console.log('status',r.status,'len',t.length);
for(const re of [/playersOnline"?\s*:\s*(\d+)/g, /Online\s+(\d+)\s+of\s+(\d+)/g, /(\d+)\s+of\s+(\d+)\s+players/gi, /last list we got[^<]{0,80}/gi, /Last seen[^<]{0,60}/gi, /Updated[^<]{0,40}/gi, /data-live[^>]{0,80}/gi]){
  re.lastIndex=0; const m=[...t.matchAll(re)].slice(0,5).map(x=>x[0]);
  console.log(String(re), JSON.stringify(m));
}
