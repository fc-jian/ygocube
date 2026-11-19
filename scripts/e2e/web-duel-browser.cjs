#!/usr/bin/env node
// Run after web-duel-smoke.cjs with its saved web-replay.json and a running web build.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const protocol = require('../../cube/packages/duel-protocol/dist');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const baseURL = process.argv[3] || 'http://127.0.0.1:3000';
const output = process.env.BROWSER_OUTPUT_DIR || require('node:path').join(require('node:os').tmpdir(), 'ygocube-browser');
fs.mkdirSync(output, {recursive:true});
(async()=>{
  const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  try {
    for(const width of [360,390,430,1440]){
      const page=await browser.newPage({viewport:{width,height:width<700?844:1000},isMobile:width<700,hasTouch:width<700});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/**',async route=>{
        const pathname=new URL(route.request().url()).pathname;
        if(pathname.endsWith('/replay'))return route.fulfill({json:fixture});
        if(pathname.endsWith('/cards'))return route.fulfill({json:fixture.cards.filter(c=>route.request().postDataJSON().codes.includes(c.code))});
        if(pathname.endsWith('/descriptions'))return route.fulfill({json:fixture.descriptions});
        if(pathname.endsWith('/matches'))return route.fulfill({json:[{id:1,resultA:null,resultB:null}]});
        if(pathname.endsWith('/duel-session'))return route.fulfill({json:{version:1,ticket:'fixture',wsPath:'/api/duel/ws'}});
        if(pathname==='/api/t/1')return route.fulfill({json:{authRequired:false}});
        return route.fulfill({status:404,body:''});
      });
      await page.goto(baseURL+'/t/1/replay/1');
      await page.waitForSelector('input[type=range]');
      const move=fixture.frames.findIndex(f=>{const b=Buffer.from(f.frame,'base64');return b[2]===1&&b[3]===50&&b[13]===4;});
      const position=Math.max(move+2,Math.min(45,fixture.frames.length));
      await page.locator('input[type=range]').fill(String(position));
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
      await page.locator('.duel-hand:not(.opponent-hand) .duel-card').first().click();
      await page.waitForSelector('.duel-dialog');await page.locator('.duel-close').click();
      await page.screenshot({path:path.join(output,`replay-${width}.png`),fullPage:true});
      const state=protocol.initialState();for(const f of fixture.frames.slice(0,position))protocol.applyFrame(state,Buffer.from(f.frame,'base64'));
      state.stage='dueling';state.prompt={message:11,kind:'command',player:state.seat,min:1,max:1,choices:[{index:0,label:'end',value:7}]};
      await page.addInitScript(({state})=>{
        window.__duelSent=[];
        window.WebSocket=class {
          static OPEN=1;readyState=1;
          constructor(){setTimeout(()=>this.onopen?.({}),0);}
          send(raw){const m=JSON.parse(raw);if(m.type==='auth'){setTimeout(()=>{for(const v of [{type:'session',role:'player'},{type:'prompt',id:1},{type:'snapshot',state}])this.onmessage?.({data:JSON.stringify(v)});},0);}else window.__duelSent.push(m);}
          close(){this.readyState=3;}
        };
      },{state});
      await page.goto(baseURL+'/t/1/duel/alice');
      await page.waitForSelector('.duel-choice-main');
      await page.locator('.duel-choice-main').first().click();
      assert.deepEqual(await page.evaluate(()=>window.__duelSent[0]),{type:'action',id:1,opcode:1,data:[7,0,0,0]});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      await page.screenshot({path:path.join(output,`duel-${width}.png`),fullPage:true});
      console.log(`PASS ${width}px replay, details, live action and overflow`);
      await page.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
