const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  await page.addInitScript(()=>{window.showDirectoryPicker=async()=>{
   const root=await navigator.storage.getDirectory();
   const dir=await root.getDirectoryHandle('ygopro-test',{create:true});
   const normal=await dir.getDirectoryHandle('pics',{create:true});
   const expansion=await (await dir.getDirectoryHandle('expansions',{create:true})).getDirectoryHandle('pics',{create:true});
   for(const [folder,name,color] of [[normal,'100200292.jpg','red'],[expansion,'100200292.png','blue']]){
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,2,2);
    const blob=await new Promise(r=>canvas.toBlob(r));const file=await folder.getFileHandle(name,{create:true});const writer=await file.createWritable();await writer.write(blob);await writer.close();
   }
   return dir;
  };});
  await page.route('**/public/duel/cards',r=>r.fulfill({json:[{code:100200292,name:'优秀精灵',type:33,level:4,desc:'先行卡测试'}]}));
  await page.goto((process.argv[2]||'http://127.0.0.1:3131')+'/duel/decks');
  await page.locator('input[type=file]').first().setInputFiles({name:'expansion.ydk',mimeType:'text/plain',buffer:Buffer.from('#main\n100200292\n#extra\n!side')});
  await page.getByText('卡图设置',{exact:true}).click();
  await page.getByRole('button',{name:'绑定本地图像目录',exact:true}).click();
  await page.waitForSelector('img[data-card-code="100200292"][src^="blob:"]');
  const pixel=await page.locator('img[data-card-code="100200292"][src^="blob:"]').first().evaluate(async img=>{
   await img.decode();const c=document.createElement('canvas');c.width=2;c.height=2;const x=c.getContext('2d');x.drawImage(img,0,0);return [...x.getImageData(0,0,1,1).data];
  });
  assert.deepEqual(pixel,[0,0,255,255]);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.reload();
  await page.getByLabel('已保存卡组').selectOption({index:1});
  await page.waitForSelector('img[data-card-code="100200292"][src^="blob:"]');
  console.log('PASS real directory binding: expansion PNG overrides base JPG and survives reload');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
