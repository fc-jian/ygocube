#!/usr/bin/env node
// Exercise field gestures with real protocol prompts and an instrumented transport.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const p = require('../../cube/packages/duel-protocol/dist');
const base = process.argv[2] || 'http://127.0.0.1:3100';
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox']});
 try {
  for (const width of (process.env.DUEL_WIDTHS ? JSON.parse(process.env.DUEL_WIDTHS) : [390,1440])) for (const seat of [0,1]) {
   const page = await browser.newPage({viewport:{width,height:1000},hasTouch:width<700,isMobile:width<700});
   await page.route('**/duel-assets/**', async route => route.fulfill({response:await route.fetch({url:route.request().url().replace('/duel-assets/', '/')})}));
   const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/duel-api/**', route => {
    const u = new URL(route.request().url()).pathname;
    const json = u.endsWith('/descriptions') ? {221:'是否在[%ls]发动[%ls]的诱发类效果？'} : u.endsWith('/cards') ? [{code:111,name:'测试主卡',type:1},{code:222,name:'测试额外',type:0x40},{code:333,name:'测试备选',type:1},{code:444,name:'备选额外',type:0x2000}] : u.endsWith('/matches') ? [{id:1,resultA:null,resultB:null}] : u.endsWith('/duel-session') ? {ticket:'test',wsPath:'/api/duel/ws'} : u.endsWith('/t/1') ? {authRequired:false} : [];
    return route.fulfill({json});
   });
   const state=p.initialState();state.seat=seat;state.stage='dueling';state.names=['Alice','Bob'];
   // An occupied spell slot must remain selectable for field-disabling prompts.
   state.cards=[{player:seat,location:8,sequence:0,code:0,position:2,materials:[],counters:{}}];
   await page.addInitScript(state=>{
    window.__sent=[];
    window.WebSocket=class {
     static OPEN=1;readyState=1;
     constructor(){window.__binary=f=>this.onmessage?.({data:new Uint8Array(f).buffer});window.__inject=v=>this.onmessage?.({data:JSON.stringify(v)});setTimeout(()=>this.onopen?.({}),0);}
     send(raw){const v=JSON.parse(raw);if(v.type==='auth')setTimeout(()=>{window.__inject({type:'session'});window.__inject({type:'snapshot',state});},0);else window.__sent.push(v);}
     close(){this.readyState=3;}
    };
   },state);
   await page.goto(base+'/t/1/duel/alice');await page.waitForSelector('.duel-table');
   let id=0;
   async function prompt(bits,count=1,message=18){
    const mask=Buffer.alloc(4);mask.writeUInt32LE((~bits.reduce((n,b)=>n|(1<<b),0))>>>0);
    state.prompt=p.decodePrompt(Buffer.concat([Buffer.from([message,seat,count]),mask]));
    await page.evaluate(({state,id})=>{window.__sent=[];window.__inject({type:'prompt',id});window.__inject({type:'snapshot',state});},{state,id:++id});
    await page.waitForSelector('.duel-zone-target:not(:disabled)');
    assert.equal(await page.locator('.duel-choice-main').count(),0);
   }
   async function chainPrompt(forced=false, count=1) {
    const header=Buffer.from([16,seat,count,0,0,0,0,0,0,0,0,0]);
    const card=Buffer.alloc(14);card[1]=Number(forced);card.writeUInt32LE(111,2);card.set([seat,2,0,1],6);
    state.prompt=p.decodePrompt(Buffer.concat([header,...(count?[card]:[])]));
    state.cards=[{player:seat,location:2,sequence:0,code:111,position:1,materials:[],counters:{}}];
    await page.evaluate(({state,id})=>{window.__sent=[];window.__inject({type:'prompt',id});window.__inject({type:'snapshot',state});},{state,id:++id});
   }
   await chainPrompt();
   await page.getByRole('alertdialog').waitFor();
   assert(await page.locator('.duel-layout').evaluate(e=>e.hasAttribute('inert')));
   assert.equal(await page.evaluate(()=>window.__sent.length),0);
   await page.getByRole('button',{name:'不响应',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[255,255,255,255]);
   await chainPrompt();
   await page.getByRole('button',{name:'响应',exact:true}).click();
   assert.equal(await page.getByRole('alertdialog').count(),0);
   assert.equal(await page.evaluate(()=>window.__sent.length),0,'confirmation does not prematurely submit a choice');
   await page.locator('.duel-card[data-card-code="111"]').click();
   await page.locator('.duel-operation-modal').getByRole('button',{name:'取消响应',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[255,255,255,255]);
   await chainPrompt();
   await page.getByRole('button',{name:'响应',exact:true}).click();
   await page.locator('.duel-card[data-card-code="111"]').click();
   await page.locator('.duel-operation-modal .duel-operation').click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[0,0,0,0]);
   await chainPrompt(true);
   await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='取消响应'));
   assert.equal(await page.getByRole('alertdialog').count(),0,'forced chain has no optional gate');
   assert.equal(await page.getByRole('button',{name:'取消响应',exact:true}).count(),0);
   await chainPrompt(false,0);
   await page.waitForFunction(()=>window.__sent.length===1);
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[255,255,255,255]);
   state.cards=[{player:seat,location:8,sequence:0,code:0,position:2,materials:[],counters:{}}];
   for (const message of [19,14,13,140,141,143]) {
    let raw;
    if(message===19)raw=Buffer.from([19,seat,111,0,0,0,5]);
    else if(message===14||message===143)raw=Buffer.from([message,seat,2,1,0,0,0,2,0,0,0]);
    else if(message===13)raw=Buffer.from([13,seat,0,0,0,0]);
    else raw=Buffer.from([message,seat,1,3,0,0,0]);
    state.prompt=p.decodePrompt(raw);
    await page.evaluate(({state,id})=>{window.__sent=[];window.__inject({type:'prompt',id});window.__inject({type:'snapshot',state});},{state,id:++id});
    await page.locator('.duel-central-prompt').waitFor();
    const rect=await page.locator('.duel-central-prompt').boundingBox();
    assert(Math.abs(rect.x+rect.width/2-width/2)<2,'mandatory choice centered horizontally');
    if(Math.abs(rect.y+rect.height/2-500)>=2)console.error({width,seat,message,rect,viewport:await page.evaluate(()=>({h:innerHeight,v:visualViewport.height})),css:await page.locator('.duel-central-prompt').evaluate(e=>({top:getComputedStyle(e).top,transform:getComputedStyle(e).transform}))});
    assert(Math.abs(rect.y+rect.height/2-500)<2,'mandatory choice centered vertically');
    await page.locator('.duel-central-prompt .duel-choice-main').first().click();
    if([140,141].includes(message))await page.getByRole('button',{name:'确认 (1)',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__sent.length),1,'one response for mandatory choice');
    if(message===19)assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[1,0,0,0]);
   }
   const target=(controller,loc,seq)=>page.locator(`[data-zone="${controller}:${loc}:${seq}"]`);
   for(const bit of [0,4,5,6,8,13,14,15,16,20,21,22,24,29,30,31]){
    await prompt([bit]);const controller=bit<16?seat:1-seat,loc=bit%16<8?4:8,seq=bit%8;
    if(width<700) await target(controller,loc,seq).tap(); else await target(controller,loc,seq).click();
    assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[controller,loc,seq]);
    assert.equal(await page.locator('.duel-zone-target:disabled').count(),1);
   }
   await prompt([0,1,8],2,24);
   await target(seat,4,0).click();assert.equal(await page.evaluate(()=>window.__sent.length),0);
   await target(seat,4,0).click();assert.equal(await target(seat,4,0).getAttribute('aria-pressed'),'false');
   await target(seat,8,0).click();await target(seat,4,1).click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[seat,8,0,seat,4,1]);
   await prompt([5,22]);assert.equal(await page.locator('.duel-zone-target').count(),1,'shared extra aliases have one target');
   await prompt([0],0);await page.locator('.duel-zone-instruction button').click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[seat,0,0]);
   await prompt([0,1,2,3,4,13,14,15],2);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), `duel-zones-${width}-${seat}.png`),fullPage:true});
   state.phase=4;state.prompt={kind:'command',message:11,player:seat,min:1,max:1,choices:[{index:0,label:'battle',value:6},{index:1,label:'end',value:7}]};
   await page.evaluate(state=>{window.__sent=[];window.__inject({type:'snapshot',state});},state);
   await page.locator('.duel-phase-track button').filter({hasText:'战斗'}).click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[6,0,0,0]);
   assert.equal(await page.locator('.duel-phase-track button').filter({hasText:'主要二'}).isDisabled(),true);
   for (const [seq,extra] of [[1,0],[3,1]]) {
    const slot=await page.locator(`[data-slot="${seat}:4:${seq}"]`).boundingBox(), ex=await page.locator(`[data-extra-slot="${extra}"]`).boundingBox();
    assert(Math.abs(slot.x+slot.width/2-ex.x-ex.width/2)<1,'extra zone aligned with main zone');
    assert(Math.abs(slot.width-ex.width)<1 && Math.abs(slot.height-ex.height)<1,'same zone size');
    assert(Math.abs(slot.width/slot.height-1)<.02,'square monster zone');
   }
   state.cards=[{player:seat,location:4,sequence:0,code:111,position:2,materials:[],counters:{}},{player:1-seat,location:4,sequence:0,code:111,position:2,materials:[],counters:{}},...[0,1].map(sequence=>({player:seat,location:2,sequence,code:111,position:0,materials:[],counters:{}}))];
   state.prompt={kind:'command',message:11,player:seat,min:1,max:1,choices:[0,1].flatMap(sequence=>[{code:111,index:sequence,value:sequence*65536,label:'summon',ref:{player:seat,location:2,sequence}},{code:111,index:sequence,value:sequence*65536+3,label:'setMonster',ref:{player:seat,location:2,sequence}}])};
   await page.evaluate(state=>{window.__sent=[];window.__inject({type:'snapshot',state});},state);
   const ownSet=page.locator(`[data-slot="${seat}:4:0"] .duel-card`);
   await ownSet.waitFor();assert((await ownSet.getAttribute('class')).includes('known-set'));
   assert.equal(await page.locator(`[data-slot="${1-seat}:4:0"] .duel-image`).count(),0,'opponent set card stays hidden');
   if(width>700){await page.mouse.move(0,0);await page.waitForTimeout(300);assert(Number(await ownSet.locator('.duel-image').evaluate(e=>getComputedStyle(e).opacity))<.6);await ownSet.hover();await page.waitForTimeout(300);assert.equal(await ownSet.locator('.duel-image').evaluate(e=>getComputedStyle(e).opacity),'1');}
   if(width>700){
    await ownSet.hover(); await page.locator('.duel-inspector').waitFor();
    assert.equal(await page.locator('.duel-inspector').evaluate(e=>getComputedStyle(e).position),'static');
    const art=ownSet.locator('.duel-image'), portrait=await art.boundingBox();
    await ownSet.evaluate(e=>e.classList.add('defense'));const landscape=await art.boundingBox();
    assert(Math.abs(portrait.width-landscape.height)<1 && Math.abs(portrait.height-landscape.width)<1,'attack and defense retain dimensions');
    await ownSet.evaluate(e=>e.classList.remove('defense'));
   }
   const phaseBox=await page.locator('.duel-phase').boundingBox(), fieldBox=await page.locator('.duel-half.opponent').boundingBox();
   assert(phaseBox.y+phaseBox.height<=fieldBox.y,'phase above both fields');
   await page.locator('.duel-hand:not(.opponent-hand) .duel-card').nth(1).click();
   assert.equal(await page.locator('.duel-dialog').getByRole('button',{name:'通常召唤',exact:true}).count(),1);
   assert.equal(await page.locator('.duel-dialog').getByRole('button',{name:'盖放怪兽',exact:true}).count(),1);
   await page.locator('.duel-dialog').getByRole('button',{name:'通常召唤',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.__sent[0].data),[0,0,1,0]);
   state.prompt={message:12,kind:'yesno',hint:221,player:seat,min:1,max:1,choices:[{index:0,code:111,ref:{player:seat,location:4,sequence:0},label:'yes',value:1},{index:1,label:'no',value:0}]};
   await page.evaluate(state=>window.__inject({type:'snapshot',state}),state);
   await page.getByText('是否在[怪兽区]发动[测试主卡]的诱发类效果？',{exact:true}).waitFor();
   assert(!(await page.locator('.duel-prompt').innerText()).includes('%ls'));
   const chain=Buffer.from([70,111,0,0,0,seat,4,0,1,seat,4,0,0,0,0,0,1]);
   await page.evaluate(f=>window.__binary(f),Array.from(p.packet(1,chain)));
   await page.locator('.effect-activate').waitFor();
   await ownSet.locator('.duel-chain-marker').filter({hasText:'1'}).waitFor();
   for(const m of [71,72,73,74])await page.evaluate(f=>window.__binary(f),Array.from(p.packet(1,Buffer.from(m===74?[m]:[m,1]))));
   await page.locator('.effect-formed').waitFor();await page.locator('.effect-resolve').waitFor();
   await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), `duel-effects-${width}-${seat}.png`),fullPage:true});
   await page.locator('.effect-end').waitFor();
   state.stage='siding';state.prompt=null;state.deck={main:[111,222],side:[333,444]};
   await page.evaluate(state=>window.__inject({type:'snapshot',state}),state);
   await page.waitForFunction(()=>document.querySelector('[data-deck-area="extra"] h3')?.textContent.includes('(1)'));
   assert.equal(await page.locator('[data-deck-area="main"] .duel-side-grid button').count(),1);
   assert.equal(await page.locator('[data-deck-area="extra"] .duel-side-grid button').count(),1);
   assert.equal(await page.locator('.duel-side-grid small').count(),0);
   await page.locator('[data-deck-area="extra"] .duel-side-grid button').click();
   assert.equal(await page.locator('[data-deck-area="side"] .duel-side-grid button').count(),3);
   await page.locator('[data-deck-area="side"] .duel-side-grid button').last().click();
   assert.equal(await page.locator('[data-deck-area="extra"] .duel-side-grid button').count(),1);
   await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), `duel-siding-${width}-${seat}.png`),fullPage:true});
   state.stage='dueling';state.phase=4;state.chain=[];
   const make=(player,location,sequence,position=1)=>({player,location,sequence,position,code:111,materials:[],counters:{}});
   state.cards=[make(seat,4,0),make(seat,8,0),make(seat,8,5),make(seat,2,0),make(seat,16,0),make(seat,32,0),make(seat,64,0),make(1-seat,4,0)];
   state.prompt={message:15,kind:'cards',player:seat,min:1,max:1,choices:[{index:0,code:0,ref:{player:1-seat,location:4,sequence:0}}]};
   await page.evaluate(state=>window.__inject({type:'snapshot',state}),state);
   await page.locator('.duel-choice-main').filter({hasText:'测试主卡'}).waitFor();
   const opposing=page.locator(`[data-slot="${1-seat}:4:0"] .duel-card`);
   assert((await opposing.getAttribute('class')).includes('card-selectable'));
   await page.getByRole("button",{name:"在场上选择",exact:true}).click();
   await opposing.click();assert.equal(await opposing.getAttribute('aria-pressed'),'true');
   await page.getByRole('button',{name:'确认 (1)',exact:true}).waitFor();
   for(const height of width<700?[667,900]:[600,1000]){
    await page.setViewportSize({width,height});await page.waitForTimeout(350);
    const boxes=await page.locator('.duel-table .duel-image').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height];}));
    assert(boxes.length>=7);
    for(const [w,h] of boxes){assert(Math.abs(w-boxes[0][0])<1 && Math.abs(h-boxes[0][1])<1,'all ordinary cards share dimensions');}
    assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1),'no document scrolling');
    for(const selector of ['.duel-controls','.duel-inspector']){const panel=await page.locator(selector).boundingBox();assert(panel.y>=0 && panel.y+panel.height<=height+1,selector+' fits viewport');}
    const confirm=await page.getByRole('button',{name:'确认 (1)',exact:true}).boundingBox();assert(confirm.y>=0 && confirm.y+confirm.height<=height+1,'confirmation remains visible');
    const board=await page.locator('.duel-table').boundingBox();if(!(board.y>=0 && board.y+board.height<=height)){await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), 'duel-fit-failure.png'),fullPage:true});console.log(await page.locator('.duel-table > *').evaluateAll(es=>es.map(e=>[e.className,e.getBoundingClientRect().height])));console.log({board,height});}assert(board.y>=0 && board.y+board.height<=height,'whole field fits viewport');
    await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), `duel-uniform-${width}-${height}-${seat}.png`),fullPage:true});
   }
   state.prompt={message:11,kind:'command',player:seat,min:1,max:1,choices:[{index:0,code:111,label:'activate',value:5,ref:{player:seat,location:16,sequence:0}}]};
   await page.evaluate(state=>window.__inject({type:'snapshot',state}),state);
   assert.equal(await page.locator('.duel-controls .duel-choice-main').count(),0);
   const grave=page.getByRole('button',{name:'墓地 1',exact:true});await grave.locator('.duel-action-vortex').waitFor();await grave.click();
   await page.locator('.duel-operation-dialog').getByRole('button',{name:'发动效果',exact:true}).click();
   await page.locator('.duel-operation-dialog').getByRole('button',{name:'确定',exact:true}).click();
   const handChain=Buffer.from([70,111,0,0,0,seat,2,0,1,seat,2,0,0,0,0,0,1]);
   await page.evaluate(f=>window.__binary(f),Array.from(p.packet(1,handChain)));
   await page.locator('.duel-hand:not(.opponent-hand) .duel-chain-marker').waitFor();
   await page.evaluate(f=>window.__binary(f),Array.from(p.packet(1,Buffer.from([74]))));
   assert.equal(await page.locator('.duel-hand:not(.opponent-hand) .duel-chain-marker').count(),1,'chain remains visible while animation plays');
   await page.locator('.effect-end').waitFor();
   await page.evaluate(f=>window.__binary(f),Array.from(p.packet(1,Buffer.from([5,seat,3]))));
   await page.locator('.duel-outcome').filter({hasText:'超时'}).waitFor();
   state.stage='siding';state.prompt=null;await page.evaluate(state=>window.__inject({type:'snapshot',state}),state);
   await page.locator('.duel-side-grid button').first().hover();await page.locator('.duel-side-hover').waitFor();
   assert(Number(await page.locator('.duel-side-hover').evaluate(e=>getComputedStyle(e).zIndex))>Number(await page.locator('.duel-modal').evaluate(e=>getComputedStyle(e).zIndex)),'side hover above modal');
   await page.setViewportSize({width,height:1000});
   state.stage='lobby';
   await page.evaluate(state=>window.__inject({type:'snapshot',state}),state);
   assert(await page.getByRole('button',{name:'准备',exact:true}).isDisabled(),'ready waits for native seat assignment');
   await page.evaluate(f=>window.__binary(f),Array.from(p.packet(0x13,Uint8Array.of(seat))));
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='准备'&&!b.disabled));
   assert.deepEqual(errors,[]); console.log(`PASS ${width}px seat ${seat}: own/opponent, extra, field, pendulum, occupied, multi, undo, cancel`);
   await page.close();
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
