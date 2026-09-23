// Review a known, fictional text fixture after checking its actual model output.
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const out='../artifacts/server-e2e', base=process.env.UI_BASE_URL||'http://127.0.0.1:8000';
const fixture=JSON.parse(await readFile(out+'/live-text-meeting.json','utf8'));
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});
try {
 await page.goto(base);
 await page.getByRole('button',{name:'Встречи',exact:true}).click();
 const library=page.getByRole('button',{name:/^Все встречи/});
 if(await library.getAttribute('aria-expanded')!=='true') await library.click();
 await page.locator('.meeting-row').filter({hasText:fixture.title}).click();
 await expect(page.getByLabel('Поручение 1',{exact:true})).toHaveValue('Подготовить демонстрационный отчёт');
 await expect(page.getByLabel('Исполнитель 1',{exact:true})).toHaveValue('Берик');
 await expect(page.getByLabel('Дата срока 1',{exact:true})).toHaveValue('2026-09-30');
 await page.screenshot({path:out+'/09-reviewed-text.png',fullPage:true});
 const current=await(await fetch(base+'/api/meetings/'+fixture.id)).json();
 if(!current.approved) await page.getByRole('button',{name:'Утвердить протокол',exact:true}).click();
 await expect(page.getByRole('button',{name:'Скачать DOCX'})).toBeEnabled();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать DOCX'}).click();
 await(await download).saveAs(out+'/fictional-approved.docx');
 await page.screenshot({path:out+'/10-approved-telegram.png',fullPage:true});
 await page.getByRole('button',{name:'Задачи',exact:true}).click();
 await page.screenshot({path:out+'/11-task-register.png',fullPage:true});
 const response=await fetch(base+'/api/meetings/'+fixture.id); const meeting=await response.json();
 if(!meeting.approved) throw new Error('Approval not persisted');
 await writeFile(out+'/live-text-approved.json',JSON.stringify(meeting,null,2));
 console.log(JSON.stringify({status:'passed',meeting_id:fixture.id,approved:meeting.approved,docx:'fictional-approved.docx'}));
} finally {await browser.close();}
