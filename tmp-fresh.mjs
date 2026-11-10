import fs from 'node:fs';
const t=fs.readFileSync('tmp-scumsa2.html','utf8');
for(const kw of ['out of date','ago','Last seen','Online 29','29 of 128','checked','stale']){
  let i=0,n=0;
  while((i=t.indexOf(kw,i))>=0 && n<4){ console.log('===',kw,'@'+i); console.log(t.slice(Math.max(0,i-300),i+300).replace(/\s+/g,' ')); i+=kw.length;n++; }
}
