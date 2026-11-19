const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
 try{
  for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:900}});
   for(const route of ['/','/admin','/duel','/duel/decks']){
    await page.goto((process.argv[2]||'http://127.0.0.1:3132')+route);
    const style=await page.evaluate(()=>{
     const element=document.createElement('div');element.className='grid p-4 gap-4 bg-felt';document.body.append(element);
     const computed=getComputedStyle(element);const result={display:computed.display,padding:parseFloat(computed.padding),gap:parseFloat(computed.gap),color:computed.backgroundColor,rem:parseFloat(getComputedStyle(document.documentElement).fontSize)};
     element.remove();return result;
    });
    assert.equal(style.display,'grid',route+' utility display missing');assert.equal(style.padding,style.rem);assert.equal(style.gap,style.rem);assert.equal(style.color,'rgb(20, 51, 42)');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),route+' horizontal overflow');
    if(route==='/' || route==='/duel/decks')await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), `layout-${route==='/'?'cube':'decks'}-${width}.png`),fullPage:true});
    console.log('PASS computed layout '+route+' '+width);
   }
   await page.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
