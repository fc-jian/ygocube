const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { window.testStream=this; this.handlers={}; }
        addEventListener(name,fn) { this.handlers[name]=fn; }
        close() {}
      };
    });
    let deck={main:[1],extra:[],side:[2,3],lockedAt:null};
    let hold=false, held, release;
    const state=()=>({status:'deckbuilding',players:[{playerId:'P1'}],config:{mainMin:0,mainMax:60,extraMax:15,sideMax:15,maxCopies:1},pickedCards:[1,2,3],deck:structuredClone(deck)});
    await page.route('**/api/**',async route=>{
      const url=route.request().url();
      if(url.includes('/pics/')) return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="70" height="100"><rect width="70" height="100" fill="blue"/></svg>'});
      if(url.includes('/cards?'))return route.fulfill({json:[1,2,3].map(code=>({code,name:'Card'+code,type:code===3?65:1,desc:'Test'}))});
      if(url.endsWith('/state')) {
        const json=state();
        if(hold){hold=false;held=true;await new Promise(r=>release=r);}
        return route.fulfill({json});
      }
      if(url.endsWith('/deck/move')) {
        const {card_code,from,to,index}=route.request().postDataJSON();
        if(from!=='pool')deck[from].splice(deck[from].indexOf(card_code),1);
        if(to!=='pool')deck[to].splice(index??deck[to].length,0,card_code);
        return route.fulfill({json:{ok:true}});
      }
      return route.fulfill({json:{authRequired:false,players:[{playerId:'P1'}]}});
    });
    await page.goto((process.argv[2]||'http://127.0.0.1:3330')+'/t/1/deck/P1');
    const card=(zone,code)=>page.locator(`[data-flip-id="${zone}:${code}:0"]`);
    await card('side',2).getByRole('button').click();
    await page.getByRole('button',{name:'移出构筑',exact:true}).click();
    await card('pool',2).waitFor();
    await card('side',3).getByRole('button').click();
    await page.getByRole('button',{name:'移动到额外卡组',exact:true}).click();
    await card('extra',3).waitFor();
    hold=true;
    await page.evaluate(()=>window.testStream.handlers.deck({data:'{}'}));
    for(let tries=0;!held && tries<500;tries++)await new Promise(r=>setTimeout(r,10));
    assert(held,'background refresh should be pending');
    await card('main',1).locator('img').dragTo(page.locator('section').filter({has:page.getByText('副卡组',{exact:true})}));
    await card('side',1).waitFor();
    release();
    await page.waitForTimeout(300);
    assert.equal(await card('main',1).count(),0,'late stale response must not undo the move');
    await card('side',1).locator('img').dragTo(page.locator('aside'));
    await card('pool',1).waitFor();
    await card('pool',1).locator('img').dragTo(page.locator('section').filter({has:page.getByText('主卡组',{exact:true})}));
    await card('main',1).waitFor();
    const section=page.locator('section').filter({has:page.getByText('主卡组',{exact:true})});
    await section.dispatchEvent('dragover',{clientX:0,clientY:0});
    await page.evaluate(()=>window.dispatchEvent(new Event('dragend')));
    assert.equal(await section.locator('span.absolute').count(),0);
    await card('main',1).getByRole('button').click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(errors,[]);
    console.log('PASS: side removal, extra routing, image dragging, delayed stale refresh, repeated moves, cancellation cleanup, details after drag');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
