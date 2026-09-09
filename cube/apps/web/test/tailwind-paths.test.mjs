import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url), postcss=require('postcss'), tailwind=require('tailwindcss');
const config=require('../postcss.config.js').plugins.tailwindcss.config;
test('utility styles compile independently of the build working directory',async()=>{
 const original=process.cwd();
 try{
  process.chdir(path.resolve(fileURLToPath(new URL('../../../..',import.meta.url))));
  const result=await postcss([tailwind({config})]).process('@tailwind utilities;',{from:undefined});
  assert.match(result.css,/\.grid\s*\{\s*display: grid[;\s]/);
  assert.match(result.css,/\.p-4\s*\{\s*padding: 1rem[;\s]/);
  assert.match(result.css,/\.bg-felt\b/);
 }finally{process.chdir(original)}
});
