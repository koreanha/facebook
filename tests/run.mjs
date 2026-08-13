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
import zlib from 'node:zlib';
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

/* ZIP 중앙 디렉터리만 읽어 항목 목록을 얻는다 (검증용 최소 구현) */
function unzipNames(buf){
  const map = new Map();
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p--;
  if (p < 0) return map;
  let o = buf.readUInt32LE(p + 16);
  const n = buf.readUInt16LE(p + 10);
  for (let i = 0; i < n; i++){
    if (buf.readUInt32LE(o) !== 0x02014b50) break;
    const method = buf.readUInt16LE(o + 10);
    const cSize  = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28);
    const extLen  = buf.readUInt16LE(o + 30);
    const comLen  = buf.readUInt16LE(o + 32);
    const lho     = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nameLen);
    map.set(name, { method, cSize, lho });
    o += 46 + nameLen + extLen + comLen;
  }
  return map;
}
function readEntry(buf, map, name){
  const e = map.get(name);
  if (!e) return '';
  const nl = buf.readUInt16LE(e.lho + 26), el = buf.readUInt16LE(e.lho + 28);
  const at = e.lho + 30 + nl + el;
  const raw = buf.subarray(at, at + e.cSize);
  return (e.method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
}
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
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
/* 실제 XML 파서로 적합성을 확인한다 (node에는 파서가 없으므로 브라우저를 쓴다) */
const wellFormed = txt => page.evaluate(t => {
  const doc = new DOMParser().parseFromString(t, 'application/xml');
  const err = doc.querySelector('parsererror');
  return err ? err.textContent.slice(0, 120) : true;
}, txt);
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
  ['정사각 · 사진 없음', { '#dSize':'square', '#dPostBreak':'flow', '#dImg':'no' }],
  ['A5 · 글 하나를 한 쪽에', { '#dSize':'a5', '#dPostBreak':'fit', '#dImg':'yes' }]
]){
  await layout(opts);
  ok(label, (await overflowing()) === 0, await page.textContent('#pvInfo'));
}

/* ------------------------------------------------- 2b. 한 쪽에 한 글 */
console.log('\n[2b] 글 하나가 한 쪽을 차지하는가');
await layout({ '#dSize':'a5', '#dCols':'1', '#dPostBreak':'fit' });
const fit = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#book .page')]
    .map(p => p.querySelectorAll('.b-ptitle').length);
  return { heads, withHead: heads.filter(n => n > 0).length, maxPerPage: Math.max(...heads) };
});
ok('한 쪽에 글은 하나씩만', fit.maxPerPage === 1, '가장 많은 쪽에 ' + fit.maxPerPage + '개');
ok('모든 글이 자기 쪽에서 시작', fit.withHead === 11, fit.withHead + '개 쪽이 글로 시작');
ok('넘친 글은 경고로 알림', /정해진 쪽수를 넘겨/.test(await page.textContent('#pvInfo')),
   await page.textContent('#pvInfo'));

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

/* ---------------------------------------------------------- 5b. 내보내기 */
console.log('\n[5b] 편집용 파일 내보내기');
await layout({ '#dSize':'a5', '#dCols':'1', '#dPostBreak':'fit' });
const pageCount = await page.locator('#book .page').count();

async function grab(fmt){
  await page.click('#btnExport');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.click('.xitem[data-fmt="' + fmt + '"]')
  ]);
  const f = path.join(HERE, 'tmp-' + fmt);
  await dl.saveAs(f);
  const buf = fs.readFileSync(f);
  fs.unlinkSync(f);
  return buf;
}

const docx = await grab('docx');
const dz = unzipNames(docx);
ok('Word 파일이 만들어짐', docx.length > 5000, docx.length + ' bytes');
ok('필수 부품이 모두 있음',
   ['[Content_Types].xml','_rels/.rels','word/document.xml','word/styles.xml',
    'word/_rels/document.xml.rels'].every(n => dz.has(n)),
   [...dz.keys()].slice(0, 6).join(', '));
ok('사진이 들어 있음', [...dz.keys()].some(n => n.startsWith('word/media/')),
   [...dz.keys()].filter(n => n.startsWith('word/media/')).length + '장');
const docXml = readEntry(docx, dz, 'word/document.xml');
const docOk = await wellFormed(docXml);
ok('document.xml 이 올바른 XML', docOk === true, docOk === true ? '' : docOk);
ok('한글이 살아 있음', docXml.includes('봄이 왔다고'));
ok('쪽 나누기가 들어감', docXml.includes('pageBreakBefore'));
const stylesXml = readEntry(docx, dz, 'word/styles.xml');
ok('w:pPr 자식 순서가 스키마대로', !/<w:jc[^>]*\/><w:spacing/.test(stylesXml));

const svgzip = await grab('svg');
const sz = unzipNames(svgzip);
const svgs = [...sz.keys()].filter(n => n.endsWith('.svg'));
ok('쪽 수만큼 SVG가 나옴', svgs.length === pageCount, svgs.length + ' / ' + pageCount);
const oneSvg = readEntry(svgzip, sz, svgs[Math.min(5, svgs.length - 1)]);
const svgOk = await wellFormed(oneSvg);
ok('SVG 가 올바른 XML', svgOk === true, svgOk === true ? '' : svgOk);
ok('글줄이 개별 개체로', (oneSvg.match(/<text /g) || []).length > 3,
   (oneSvg.match(/<text /g) || []).length + '개');
const withImg = svgs.map(n => readEntry(svgzip, sz, n)).filter(t => t.includes('<image '));
ok('사진이 SVG 안에 심어짐', withImg.some(t => t.includes('xlink:href="data:image/')),
   withImg.length + '개 쪽에 사진');

const html = await grab('html');
const htmlText = html.toString('utf8');
ok('HTML 이 만들어짐', /<!doctype html>/i.test(htmlText), html.length + ' bytes');
ok('사진이 파일 안에 담김', htmlText.includes('src="data:image/'));
ok('쪽이 모두 담김', (htmlText.match(/class="page"/g) || []).length === pageCount);

/* ---------------------------------------------------------- 6. 오류 */
console.log('\n[6] 콘솔');
ok('자바스크립트 오류 없음', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures ? '\n실패 ' + failures + '건\n' : '\n전부 통과\n');
process.exit(failures ? 1 : 0);
