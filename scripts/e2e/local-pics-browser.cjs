const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const code=Number(process.env.PIC_CODE||100200292);
const bytes=process.env.PIC_FILE ? [...fs.readFileSync(process.env.PIC_FILE)] : null;
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.addInitScript(({code,bytes})=>{window.showDirectoryPicker=async()=>{
   const root=await navigator.storage.getDirectory();
   const dir=await root.getDirectoryHandle('ygopro-test',{create:true});
   const normal=await dir.getDirectoryHandle('pics',{create:true});
   const expansion=await (await dir.getDirectoryHandle('expansions',{create:true})).getDirectoryHandle('pics',{create:true});
   for(const [folder,name,color] of [[normal,`${code}.jpg`,'red'],[expansion,`${code}.png`,'blue']]){
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,2,2);
    const blob=await new Promise(r=>canvas.toBlob(r));const file=await folder.getFileHandle(name,{create:true});const writer=await file.createWritable();await writer.write(blob);await writer.close();
   }
   const jpeg=await expansion.getFileHandle(`${code}.jpg`,{create:true});
   const writer=await jpeg.createWritable();await writer.write(bytes ? new Uint8Array(bytes) : 'incomplete download');await writer.close();
   return dir;
  };},{code,bytes});
  if(!bytes)await page.route('**/public/duel/cards',r=>r.fulfill({json:[{code,name:'优秀精灵',type:33,level:4,desc:'先行卡测试'}]}));
  await page.goto((process.argv[2]||'http://127.0.0.1:3132')+'/duel/decks');
  await page.locator('input[type=file]').first().setInputFiles({name:'expansion.ydk',mimeType:'text/plain',buffer:Buffer.from(`#main\n${code}\n#extra\n!side`)});
  await page.getByText('卡图设置',{exact:true}).click();
  await page.getByRole('button',{name:'绑定本地图像目录',exact:true}).click();
  const selector=`img[data-card-code="${code}"][src^="blob:"]`;
  await page.waitForSelector(selector);
  await page.waitForFunction(selector=>{const img=document.querySelector(selector);return img&&img.complete&&img.naturalWidth>0},selector);
  const result=await page.locator(selector).first().evaluate(async (img,bytes)=>{
   function render(image){const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d');x.drawImage(image,0,0);return {data:c.toDataURL(),pixel:[...x.getImageData(0,0,1,1).data]};}
   const actual=render(img);
   if(!bytes)return {pixel:actual.pixel};
   const expected=new Image();expected.src='data:image/jpeg;base64,'+btoa(bytes.map(n=>String.fromCharCode(n)).join(''));await expected.decode();
   return {matches:actual.data===render(expected).data,width:img.naturalWidth,height:img.naturalHeight};
  },bytes);
  if(bytes){assert.equal(result.matches,true);assert(result.width>0&&result.height>0);}else assert.deepEqual(result.pixel,[0,0,255,255]);
  const before=await page.locator(selector).first().getAttribute('src');
  await page.getByRole('button',{name:'重新读取卡图',exact:true}).click();
  await page.waitForFunction(({selector,before})=>{const img=document.querySelector(selector);return img&&img.src!==before&&img.complete&&img.naturalWidth>0},{selector,before});
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.reload();
  await page.getByLabel('已保存卡组').selectOption({index:1});
  await page.waitForSelector(selector);
  console.log(`PASS directory binding ${code}: ${bytes?'exact JPEG rendered pixels matched':'invalid JPEG skipped for PNG'}, reread and reload`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
