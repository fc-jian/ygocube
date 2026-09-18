const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const base=process.argv[2] || 'http://127.0.0.1:3330';
const cards=[{code:111,name:'灵魂测试卡',type:0x221,desc:'完整效果第一行\n完整效果第二行',atk:1800,def:1200,level:4,race:1,attribute:16,lscale:0,rscale:0,linkMarkers:0,setCodes:[1],setNames:['测试字段'],alias:222,aliasName:'规则原名',pickStats:[{poolId:1,poolName:'不该显示',averagePickPosition:1,averagePickPercentage:1,packCount:1,tournamentCount:1}]}];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 try {for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/public/duel/**',route=>route.fulfill({json:route.request().url().includes('/options')?{lists:[{id:-1,name:'无限制',limits:{}},{id:0,name:'2026.01.01 OCG',limits:{222:0}},{id:1,name:'2026.04.01 OCG',limits:{222:1}},{id:2,name:'2026.07.01 TCG',limits:{222:2}}]}:cards}));
  await page.goto(base+'/duel/decks');
  if(width===1440){
   const box=await page.locator('.deck-banlist').boundingBox(),clear=await page.getByRole('button',{name:'清空',exact:true}).boundingBox();
   assert(Math.abs(box.y-clear.y)<4 && box.x>clear.x,'banlist must sit to the right of existing buttons');
  }
  await page.getByLabel('搜索卡片',{exact:true}).fill('测试');
  await page.locator('.builder-results article').first().waitFor();
  assert.equal(await page.getByLabel('禁限卡表',{exact:true}).inputValue(),'1');
  await page.locator('.builder-results .card-preview').click();
  const text=await page.locator('.deck-inspector').innerText();
  for(const value of ['灵魂','测试字段','规则同名：规则原名','完整效果第二行']) assert(text.includes(value),value);
  assert(!text.includes('抓位'));assert(!text.includes('undefined'));
  assert.equal(await page.locator('.builder-results .deck-limit').innerText(),'1');
  await page.getByLabel('禁限卡表',{exact:true}).selectOption('0');
  assert.equal(await page.locator('.builder-results .deck-limit').innerText(),'0');
  await page.getByRole('button',{name:'添加 灵魂测试卡',exact:true}).click();
  assert.equal(await page.locator('.builder-zone .deck-limit').innerText(),'0');
  await page.getByLabel('禁限卡表',{exact:true}).selectOption('-1');
  assert.equal(await page.locator('.deck-limit').count(),0);
  await page.locator('.builder-zone .card-preview').dblclick();
  assert((await page.locator('dialog').innerText()).includes('测试字段'));
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'horizontal overflow');
  await page.screenshot({path:`data/details-${width}.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  await page.close();console.log(JSON.stringify({width,details:true,alias:true,banlists:true,overflow:false}));
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
