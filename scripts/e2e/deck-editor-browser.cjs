#!/usr/bin/env node
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const base=process.argv[2] || 'http://127.0.0.1:3121';
const cards=[{code:111,name:'测试战士',type:17,desc:'测试通常怪兽。',atk:1800,def:1200,level:4,race:1,attribute:1},{code:222,name:'测试融合',type:65,desc:'测试额外卡片。',atk:2500,def:2000,level:8,race:1,attribute:16},{code:333,name:'测试魔法',type:2,desc:'测试魔法效果。'}];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
 try {for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/duel-assets/**',async route=>route.fulfill({response:await route.fetch({url:route.request().url().replace('/duel-assets/','/')})}));
  await page.route('**/duel-api/**',route=>route.fulfill({json:cards}));
  await page.goto(base+'/duel/decks');
  await page.locator('input[type=file]').setInputFiles({name:'编辑测试.ydk',mimeType:'text/plain',buffer:Buffer.from('#main\n'+Array(40).fill(111).join('\n')+'\n#extra\n222\n!side\n333')});
  await page.getByRole('status').filter({hasText:'已导入并保存'}).waitFor();
  assert.equal(await page.locator('[data-deck-zone=main] article').count(),40);
  await page.locator('[data-deck-zone=main] .card-preview').first().click();
  await page.locator('.deck-inspector h2').filter({hasText:'测试战士'}).waitFor();
  await page.getByRole('button',{name:'移到 备选卡组 1',exact:true}).click();
  assert.equal(await page.locator('[data-deck-zone=main] article').count(),39);
  assert.equal(await page.locator('[data-deck-zone=side] article').count(),2);
  await page.locator('[data-deck-zone=extra] .card-preview').first().dblclick();
  assert.equal(await page.locator('[data-deck-zone=extra] article').count(),0);
  await page.locator('[data-deck-zone=side] .card-preview').last().dblclick();
  assert.equal(await page.locator('[data-deck-zone=extra] article').count(),1);
  await page.getByRole('textbox',{name:'搜索卡片',exact:true}).fill('测试');
  await page.locator('.builder-results article').first().waitFor();
  if(width===1440){
   await page.locator('.builder-results article').first().dragTo(page.locator('[data-deck-zone=extra]'));
   await page.getByRole('status').filter({hasText:'这张卡不能加入额外卡组'}).waitFor();
   assert.equal(await page.locator('[data-deck-zone=extra] article').count(),1);
   await page.locator('.builder-results article').nth(1).dragTo(page.locator('[data-deck-zone=side]'));
   assert.equal(await page.locator('[data-deck-zone=side] article').count(),3);
  }
  await page.getByRole('button',{name:'添加 测试融合',exact:true}).click();
  assert.equal(await page.locator('[data-deck-zone=extra] article').count(),2);
  await page.getByLabel('筛选搜索结果').selectOption('2');
  assert.equal(await page.locator('.builder-results article').count(),1);
  await page.getByLabel('筛选搜索结果').selectOption('0');
  await page.getByRole('button',{name:'保存*',exact:true}).click();
  await page.reload();await page.getByLabel('已保存卡组').selectOption({index:1});
  await page.getByRole('button',{name:'另存',exact:true}).click();
  assert.equal(await page.getByLabel('已保存卡组').locator('option').count(),3);
  await page.getByRole('button',{name:'删除',exact:true}).click();
  assert.equal(await page.getByLabel('已保存卡组').locator('option').count(),2);
  await page.getByLabel('已保存卡组').selectOption({index:1});
  assert.equal(await page.locator('[data-deck-zone=main] article').count(),39);
  assert.equal(await page.locator('[data-deck-zone=extra] article').count(),2);
  await page.getByRole('textbox',{name:'搜索卡片',exact:true}).fill('测试');
  await page.locator('.builder-results .card-preview').first().click();
  assert(await page.locator('.deck-inspector').isVisible());
  const [left,center,right]=await Promise.all(['.deck-inspector','.deck-zones','.deck-search'].map(s=>page.locator(s).boundingBox()));
  if(width===1440)assert(left.x+left.width<=center.x+1 && center.x+center.width<=right.x+1,'native three-column layout');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1),'editor fits viewport');
  await page.screenshot({path:`/tmp/deck-editor-${width}.png`,fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS deck editor '+width+': import, move, extra classification, search, save/reload, layout');
  await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
