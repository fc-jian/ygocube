#!/usr/bin/env node
// Both creation directions use one real host: native TCP + browser gateway WebSocket.
const assert = require('node:assert/strict'), fs = require('node:fs'), net = require('node:net');
const p = require(process.env.DUEL_PROTOCOL_MODULE || '../../cube/packages/duel-protocol/dist');
const { WebSocket } = require(process.env.WS_MODULE || '../../cube/apps/api/node_modules/ws');
const [base, fixture, nativeHost, nativePort] = process.argv.slice(2);
const prefix = process.env.API_PREFIX ?? '/duel-api', origin = process.env.TEST_ORIGIN || base;
const clients = [], deck = {main:[],extra:[],side:[]};
let section='main';
for(const line of fs.readFileSync(fixture,'utf8').split(/\r?\n/)) {
 if(line==='#main')section='main';else if(line==='#extra')section='extra';else if(line==='!side')section='side';else if(/^\d+$/.test(line))deck[section].push(+line);
}
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn,label) {for(let i=0;i<400;i++){for(const c of clients)assert.deepEqual(c.errors,[]);if(await fn())return;await delay(75);}console.error(clients.map(c=>({stage:c.state.stage,host:c.state.host,seat:c.state.seat,prompt:c.state.prompt,wins:c.wins,closed:c.closed,cards:c.state.cards.length,chats:c.chats})));throw Error('TIMEOUT '+label);}
async function api(route,body){const r=await fetch(base+prefix+'/public/duel/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:origin},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();}
function state(){const c={state:p.initialState(),errors:[],id:0,wins:0,starts:0,chats:[],joined:false};clients.push(c);return c;}
function frame(c,f){if(f[2]===0x17)return;p.applyFrame(c.state,new Uint8Array(f));if(f[2]===0x13)c.joined=true;if(f[2]===1&&f[3]===5)c.wins++;if(f[2]===1&&f[3]===4)c.starts++;if(f[2]===0x19)c.chats.push(Buffer.from(f).subarray(5).toString('utf16le').replace(/\0/g,''));}
async function native(password,name){
 const c=state(),s=net.connect(+nativePort,nativeHost),framer=new p.Framer();c.close=()=>s.destroy();
 c.send=(op,data=new Uint8Array())=>{s.write(p.packet(op,data));if([1,2,3,4].includes(op))c.state.prompt=null;if(op===2)c.state.stage='waitingSide';};
 s.on('error',e=>c.errors.push(String(e)));s.on('close',()=>c.closed=true);
 s.on('data',buf=>{try{for(const f of framer.feed(buf)){frame(c,f);c.id++;if(f[2]===0x12)c.send(2,p.encodeDeck([...deck.main,...deck.extra],deck.side));if(f[2]===0x18)c.send(0x15);}}catch(e){c.errors.push(String(e));}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.destroy();reject(Error('Native TCP connection timeout'));},10000);s.once('connect',()=>{clearTimeout(timer);resolve();});s.once('error',e=>{clearTimeout(timer);reject(e);});});const n=Buffer.alloc(40),j=Buffer.alloc(Math.max(48,10+password.length*2));n.write(name,0,38,'utf16le');j.writeUInt16LE(4962);j.write(password,8,j.length-10,'utf16le');c.send(0x10,n);c.send(0x12,j);
 await until(()=>c.joined,'native seat');return c;
}
async function web(credential){
 const t=await api('session',{credential}),c=state(),ws=new WebSocket(base.replace(/^http/,'ws')+prefix+'/duel/ws',{origin});c.close=()=>ws.terminate();
 c.send=(opcode,data=new Uint8Array())=>ws.send(JSON.stringify({type:'action',id:c.id,opcode,data:Array.from(data)}));
 ws.on('open',()=>ws.send(JSON.stringify({type:'auth',version:1,ticket:t.ticket})));
 ws.on('error',e=>c.errors.push(String(e)));ws.on('close',()=>c.closed=true);
 ws.on('message',(raw,binary)=>{try{if(binary)frame(c,raw);else{const v=JSON.parse(raw);if(v.type==='prompt')c.id=v.id;if(v.type==='accepted'){c.state.prompt=null;if(v.opcode===2)c.state.stage='waitingSide';}if(v.type==='error')c.errors.push(v);}}catch(e){c.errors.push(String(e));}});
 await until(()=>c.joined,'web seat');return c;
}
async function match(a,b){
 await until(()=>a.state.host&&a.state.names.filter(Boolean).length===2,'two players');a.send(0x22);b.send(0x22);await until(()=>a.state.ready.every(Boolean),'ready');a.send(0x25);
 const sent=new Map(),sided=new Set(),surrendered=new Set();
 await until(()=>{
  for(const c of [a,b]){
   if(c.closed||sent.get(c)===c.id)continue;
   const s=c.state;
   if(s.stage==='hand'){sent.set(c,c.id);c.send(3,Uint8Array.of(c===a?1:2));}
   else if(s.stage==='turn'){sent.set(c,c.id);c.send(4,Uint8Array.of(1));}
   else if(s.stage==='siding'){sent.set(c,c.id);const main=[...deck.main,...deck.extra],side=[...deck.side];[main[0],side[0]]=[side[0],main[0]];c.send(2,p.encodeDeck(main,side));sided.add(c);}
   else if(s.prompt){sent.set(c,c.id);const q=s.prompt;
    if(q.kind==='command'){const choice=q.choices.find(x=>x.label==='summon')||q.choices.find(x=>x.label==='end')||q.choices[0];c.send(1,p.integer(choice.value));}
    else if(q.kind==='place')c.send(1,p.encodeSelection(q,[q.choices[0].index]));
    else if(q.kind==='cards')c.send(1,p.encodeSelection(q,q.choices.slice(0,q.min).map(x=>x.index)));
    else if(q.cancel)c.send(1,p.integer(-1));else if(q.kind==='yesno')c.send(1,p.integer(0));else throw Error('Unhandled '+q.kind);
   }
  }
  if(a.wins===b.wins&&a.starts===a.wins+1&&b.starts===b.wins+1&&a.state.stage==='dueling'&&b.state.stage==='dueling'&&a.state.cards.some(c=>c.location===4)&&!surrendered.has(a.wins)){surrendered.add(a.wins);b.send(0x14);}
  return a.wins===2&&b.wins===2;
 },'BO3 completion');
 assert.equal(sided.size,2);a.close();b.close();
}
(async()=>{
 const {defaults}=await api('options');
 for(const nativeFirst of [false,true]){
  const suffix=Date.now().toString(36),password=nativeFirst?'M,NOCHECK#'+suffix:'interop-'+suffix;
  let a,b,info,n;
  if(nativeFirst){a=n=await native(password,'NativeA'+suffix.slice(-6));info=await api('resolve',{password});assert.equal(info.options.mode,1);const join=await api('join',{password,name:'WebB',deck,options:{...defaults,mode:0}});assert.equal(join.room,info.room);assert.equal(join.options.mode,1);b=await web(join.credential);}
  else{info=await api('join',{password,name:'WebA',deck,options:{...defaults,mode:1,timeLimit:180}});a=await web(info.credential);info=await api('rooms/'+info.room);b=n=await native(info.nativeConnection.password,'NativeB'+suffix.slice(-6));const resolved=await api('resolve',{password:info.nativeConnection.password});assert.equal(resolved.room,info.room);}
  await until(()=>n.chats.some(x=>x.includes('/duel/room/'+info.room)),'native web invitation');
  assert(n.chats.some(x=>x.includes(info.nativeConnection.password)));
  await match(a,b);
  console.log(JSON.stringify({ok:true,nativeFirst,room:info.room,games:2,sideboarding:true,invitation:true}));
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clients.forEach(c=>c.close?.()));
