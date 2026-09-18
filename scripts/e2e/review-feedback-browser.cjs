const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert=require('node:assert/strict');
const base=process.argv[2] || 'http://127.0.0.1:3330';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let failLoad=false, failLock=true;
  await page.route('**/api/**',route=>{
   const url=route.request().url();
   if(url.includes('/stream'))return route.fulfill({contentType:'text/event-stream',body:''});
   if(url.includes('/deck/lock') && failLock)return route.fulfill({status:400,json:{code:'DECK_INVALID'}});
   if(url.includes('/state') && failLoad)return route.fulfill({status:503,json:{code:'INTERNAL_ERROR'}});
   const json=url.includes('/state')?{status:'deckbuilding',players:[{playerId:'P1',displayName:'P1'}],config:{mainMin:40},pickedCards:[],deck:{main:[],extra:[],side:[],lockedAt:null}}:{authRequired:false,players:[{playerId:'P1'}]};
   return route.fulfill({json});
  });
  await page.goto(base+'/t/1/deck/P1');
  const lock=page.getByRole('button',{name:'锁定卡组',exact:true});await lock.click();
  await page.locator('[role="alert"]:not(#__next-route-announcer__)').waitFor();
  await page.getByRole('button',{name:'关闭提示 / Dismiss',exact:true}).click();await page.locator('[role="alert"]:not(#__next-route-announcer__)').waitFor({state:'detached'});
  await lock.click();await page.locator('[role="alert"]:not(#__next-route-announcer__)').waitFor();
  await page.locator('[role="alert"]:not(#__next-route-announcer__)').waitFor({state:'detached',timeout:10000});
  await lock.click();await page.locator('[role="alert"]:not(#__next-route-announcer__)').waitFor();failLock=false;await lock.click();
  await page.locator('[role="alert"]:not(#__next-route-announcer__)').waitFor({state:'detached'});
  failLoad=true;await page.reload();await page.getByRole('button',{name:'重新加载',exact:true}).waitFor();
  assert((await page.locator('[role="alert"]:not(#__next-route-announcer__)').innerText()).includes('服务器暂时不可用'));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({dismiss:true,autoExpire:true,successfulRetry:true,initialFailureVisible:true}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
