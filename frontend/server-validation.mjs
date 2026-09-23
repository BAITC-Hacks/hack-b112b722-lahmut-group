// Run against a real server; no ML or Telegram stubs. Artifacts may contain private audio text.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:8000';
const out = resolve('../artifacts/server-e2e');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const report={base,started_at:new Date().toISOString(),runs:[],errors};
async function api(path, options) {
 const response=await fetch(base+'/api'+path,options);
 if(!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
 return response.json();
}
async function shot(name) {await page.screenshot({path:out+'/'+name+'.png',fullPage:true});}
try {
 const health=await api('/health'); report.health=health;
 if(!Object.values(health.providers).every(Boolean) || health.details.test_mode) throw new Error('Real model providers required');
 await page.goto(base); await shot('01-overview');
 for (const [index,audio] of ['meeting-1.mp3','meeting-2.mp3'].entries()) {
  const start=Date.now();
  await page.getByRole('button',{name:'Новая встреча',exact:true}).click();
  const modal=page.getByRole('dialog');
  await modal.getByLabel('Название встречи',{exact:true}).fill(`GPU E2E — запись ${index+1} — ${new Date().toISOString()}`);
  await modal.getByLabel('Дата встречи',{exact:true}).fill('2026-09-23');
  await modal.getByLabel('Файл записи').setInputFiles(resolve('../eval/audio/'+audio));
  await modal.getByLabel('Подтверждаю, что участники уведомлены',{exact:false}).check();
  await shot(`0${index+2}-upload`);
  const responsePromise=page.waitForResponse(r=>r.url().endsWith('/meetings/audio')&&r.request().method()==='POST');
  await modal.getByRole('button',{name:'Создать встречу'}).click();
  const response=await responsePromise;
  if(!response.ok()) throw new Error(await response.text());
  let meeting=await response.json(); const states=[meeting.status];
  await shot(`0${index+4}-processing`);
  for(let poll=0;poll<300;poll++) {
   meeting=await api('/meetings/'+meeting.id);
   if(states.at(-1)!==meeting.status) states.push(meeting.status);
   if(['review_ready','failed'].includes(meeting.status)) break;
   await new Promise(r=>setTimeout(r,1000));
  }
  await writeFile(out+`/meeting-${index+1}.json`,JSON.stringify(meeting,null,2));
  if(meeting.status!=='review_ready') throw new Error(JSON.stringify({status:meeting.status,error:meeting.error}));
  await expect(page.getByLabel('Краткий итог встречи')).toHaveValue(meeting.summary,{timeout:15000});
  await expect(page.getByLabel('Поручение 1',{exact:true})).toHaveValue(meeting.actions[0].title);
  await shot(`0${index+6}-real-result`);
  const range=await fetch(base+`/api/meetings/${meeting.id}/audio`,{headers:{Range:'bytes=0-43'}});
  if(range.status!==206) throw new Error('Audio range failed');
  report.runs.push({id:meeting.id,audio,states,seconds:(Date.now()-start)/1000,segments:meeting.segments.length,actions:meeting.actions.length,warnings:meeting.warnings,quality_review:'not_performed'});
  await page.reload();
  await expect(page.getByLabel('Краткий итог встречи')).toHaveValue(meeting.summary);
 }
 await page.setViewportSize({width:390,height:844}); await shot('08-mobile-real-result');
 if(errors.length) throw new Error('Browser errors: '+errors.join('; '));
 report.status='passed';
} catch(error) {report.status='failed';report.error=String(error);await shot('failure');process.exitCode=1;}
finally {report.finished_at=new Date().toISOString();await writeFile(out+'/real-browser-report.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report,null,2));}
