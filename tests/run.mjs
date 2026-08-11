/**
 * index.html 회귀 테스트.
 *
 *   python3 tests/make_sample_export.py tests/sample_export.zip
 *   npm i playwright && node tests/run.mjs
 *
 * 확인 항목
 *   - 페이스북 내보내기 ZIP 파싱과 한글(모지바케) 복구
 *   - 사진 추출
 *   - 조판: 어떤 판형·단 수에서도 글이 페이지 밖으로 넘치지 않을 것
 *   - 목차 쪽수가 실제 본문 위치와 일치할 것
 *   - 중철 소책자 배치 순서
 *   - PDF 출력
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ZIP  = path.join(HERE, 'sample_export.zip');
const PORT = 8099;

if (!fs.existsSync(ZIP)){
  console.error('먼저 실행하세요:  python3 tests/make_sample_export.py tests/sample_export.zip');
  process.exit(1);
}

let failures = 0;
const ok   = (name, cond, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  — ' + extra : ''));
  if (!cond) failures++;
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  fs.readFile(file, (e, b) => {
    if (e){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(b);
  });
});
await new Promise(r => server.listen(PORT, r));

const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: fs.existsSync(exe) ? exe : undefined,
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => {
  if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
});

await page.goto('http://localhost:' + PORT + '/');

/* ---------------------------------------------------------- 1. 불러오기 */
console.log('\n[1] 내보내기 ZIP 불러오기');
await page.setInputFiles('#fileInput', ZIP);
await page.waitForFunction(() => document.querySelector('#stats').style.display === '', null, { timeout: 30000 });

const loadLog = await page.textContent('#loadLog');
await page.click('.tab[data-view="posts"]');
await page.waitForSelector('.post');
const first = await page.inputValue('.post .txt');
const bodies = await page.$$eval('.post .txt', els => els.map(e => e.value));

// 글 6 + 앨범 3(그중 1장은 게시물에 이미 붙어 있어 제외) + 미분류 2 + ZIP에 없는 사진 1
ok('게시물을 찾음', (await page.locator('.post').count()) === 11,
   (await page.locator('.post').count()) + '개');
ok('한글 모지바케 복구', first.startsWith('봄이 왔다고'), first.slice(0, 24));
ok('앨범 JSON 안의 사진도 인식', bodies.includes('속초에서 본 일출.'));
ok('미분류 사진도 인식', bodies.includes('고양이.'));
ok('게시물에 이미 붙은 앨범 사진은 중복으로 넣지 않음',
   !bodies.includes('강릉 안목해변 파도.'));
ok('ZIP 안의 사진 추출', (await page.locator('.post .thumbs img').count()) === 7,
   (await page.locator('.post .thumbs img').count()) + '장');
ok('ZIP에 없는 사진은 자리 표시로', (await page.locator('.post .thumbs .ph').count()) === 1);
ok('빠진 사진을 로그로 알림', /⚠ 1장은 올린 파일 안에 없습니다/.test(loadLog));
ok('장소 정보 파싱', (await page.locator('.post .badge', { hasText: '강릉' }).count()) > 0);

/* ---------------------------------------------------------- 2. 조판 */
const overflowing = () => page.evaluate(() =>
  [...document.querySelectorAll('#book .col')].filter(c => c.scrollHeight > c.clientHeight + 2).length);

async function layout(opts){
  await page.click('.tab[data-view="design"]');
  for (const [sel, val] of Object.entries(opts)) await page.selectOption(sel, val);
  await page.click('.tab[data-view="preview"]');
  await page.waitForFunction(() => /총 \d+쪽/.test(document.querySelector('#pvInfo').textContent),
    null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

console.log('\n[2] 조판 — 페이지 밖으로 넘치는 글이 없어야 함');
for (const [label, opts] of [
  ['A5 1단',  { '#dSize':'a5', '#dCols':'1', '#dImpose':'none' }],
  ['A4 2단',  { '#dSize':'a4', '#dCols':'2' }],
  ['B5 1단 · 글마다 새 페이지', { '#dSize':'b5', '#dCols':'1', '#dPostBreak':'page' }],
  ['정사각 · 사진 없음', { '#dSize':'square', '#dPostBreak':'flow', '#dImg':'no' }]
]){
  await layout(opts);
  ok(label, (await overflowing()) === 0, await page.textContent('#pvInfo'));
}

/* ---------------------------------------------------------- 3. 목차 */
console.log('\n[3] 목차 쪽수가 실제 본문 위치와 일치');
await layout({ '#dSize':'a5', '#dCols':'1', '#dImg':'yes' });
const toc = await page.evaluate(() => {
  const pages = [...document.querySelectorAll('#book .page')];
  const foot  = pages.map(p => (p.querySelector('.pf') || {}).textContent || '');
  return [...document.querySelectorAll('.b-toc')].map(t => {
    const n     = t.querySelector('.pp').textContent;
    const title = t.querySelector('.tt').textContent;
    const date  = title.split(' · ')[0];
    const tail  = title.split(' · ').slice(1).join(' · ').replace(/…$/, '').slice(0, 12);
    const i     = foot.indexOf(n);
    // 설명 없는 사진은 목차에 "(사진)"으로만 나오므로 본문 대조는 날짜로 한다
    const body  = i >= 0 ? pages[i].textContent : '';
    const hit = i >= 0 && body.includes(date) &&
                (/^\(.*\)$/.test(tail) || body.includes(tail));
    return { n, key: date + ' · ' + tail, hit };
  });
});
ok('목차 항목이 모두 생성됨', toc.length === 11, toc.length + '개');
ok('모든 목차 쪽수가 정확', toc.every(t => t.hit),
   toc.filter(t => !t.hit).map(t => t.n + ':' + t.key).join(', ') || '전부 일치');
ok('페이스북 자동 문구가 제목으로 새지 않음', !toc.some(t => /님이 게시물을/.test(t.key)));

/* ---------------------------------------------------------- 4. 소책자 */
console.log('\n[4] 중철 소책자 배치');
await layout({ '#dImpose':'booklet' });
const order = await page.evaluate(() =>
  [...document.querySelectorAll('#book .sheet')].map(s =>
    [...s.querySelectorAll('.page')].map(p => {
      const f = p.querySelector('.pf');
      return p.classList.contains('blank') ? '·' : (f && f.textContent ? f.textContent : 'C');
    }).join(',')));
// n쪽짜리 책의 첫 장 앞면은 (n, 1), 뒷면은 (2, n-1)
const total = +(await page.textContent('#pvInfo')).match(/총 (\d+)쪽/)[1];
const n = Math.ceil(total / 4) * 4;
ok('장 수', order.length === n / 2, order.length + '장(면)');
ok('첫 장 앞면 = (' + n + ', 1)', order[0] === n + ',C', order[0]);
ok('첫 장 뒷면 = (2, ' + (n - 1) + ')', order[1] === 'C,' + (n - 1), order[1]);
ok('소책자에서도 넘침 없음', (await overflowing()) === 0);

/* ---------------------------------------------------------- 5. PDF */
console.log('\n[5] PDF 출력');
await layout({ '#dImpose':'none' });
await page.emulateMedia({ media: 'print' });
await page.evaluate(() => { document.querySelector('#book').style.zoom = 1; });
const pdf = path.join(HERE, 'out.pdf');
await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
await page.emulateMedia({ media: 'screen' });
ok('PDF 생성', fs.statSync(pdf).size > 20000, fs.statSync(pdf).size + ' bytes');
fs.unlinkSync(pdf);

/* ---------------------------------------------------------- 6. 오류 */
console.log('\n[6] 콘솔');
ok('자바스크립트 오류 없음', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures ? '\n실패 ' + failures + '건\n' : '\n전부 통과\n');
process.exit(failures ? 1 : 0);
