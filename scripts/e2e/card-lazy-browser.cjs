const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try {
  for(const width of [1440,390]) {
   const page=await browser.newPage({viewport:{width,height:900}}), requests=new Set(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   const cards=Array.from({length:750},(_,i)=>({code:10000+i,name:`检索卡片${i}`,type:33,desc:'效果',level:4,setCodes:[],setNames:[]}));
   await page.route('**/api/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.includes('/pics/')){
     requests.add(Number(url.pathname.match(/pics\/(\d+)/)[1]));
     return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="70" height="100"><rect width="70" height="100" fill="navy"/></svg>'});
    }
    if(url.pathname.endsWith('/cards'))return route.fulfill({json:cards.filter(c=>url.searchParams.get('codes')?.split(',').includes(String(c.code)))});
    return route.fulfill({json:{id:1,name:'lazy',count:750,codes:cards.map(c=>c.code)}});
   });
   await page.goto((process.argv[2]||'http://127.0.0.1:3332')+'/pool/lazy');
   await page.locator('[data-card-search]').last().waitFor({state:'attached'});
   await page.locator('[data-card-image] img').first().waitFor();
   await page.waitForTimeout(400);
   const initial=requests.size;
   assert(initial>0 && initial<150,`initial requests ${initial} should be bounded by viewport`);
   assert.equal(await page.locator('[data-card-search]').count(),750);
   assert(!requests.has(10749),'last card must not preload');
   assert(await page.evaluate(()=>window.find('检索卡片749 00010749',false,false,true)), 'browser Find must match hidden name + code');
   await page.locator('[data-card-image][data-card-code="10749"] img').waitFor();
   const rect=await page.locator('[data-card-image][data-card-code="10749"]').boundingBox();
   assert(rect.y<900 && rect.y+rect.height>0,'Find should scroll to the matching card');
   assert(requests.size<250,'Find should only load around destination');
   await page.evaluate(()=>{window.getSelection()?.removeAllRanges();window.scrollTo(0,0)});
   await page.waitForTimeout(200);
   await page.mouse.wheel(0,1600);
   await page.waitForTimeout(500);
   assert(requests.size>initial);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
   await page.screenshot({path:`data/card-lazy-${width}.png`});
   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({width,cards:750,initialRequests:initial,afterScroll:requests.size,findScrolled:true}));
   await page.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
