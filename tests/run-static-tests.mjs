import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_IMPORT_ROWS,
  parseTextRecords,
} from '../src/importer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const normal = parseTextRecords(read('tests/fixtures/学生名单_正常.csv'), 'normal.csv');
assert.equal(normal.rows.length, 4, '正常 CSV 应解析出 4 条记录');
assert.equal(normal.rows[0].roomNo, '101');
assert.equal(normal.rows[0].className, '计算机应用技术1班');

const text = parseTextRecords(read('tests/fixtures/学生名单_文本.txt'), 'text.txt');
assert.equal(text.rows.length, 3, '文本名单应解析出 3 条记录');

const markdown = parseTextRecords(read('tests/fixtures/学生名单_异常与重复.md'), 'bad.md');
assert.equal(markdown.rows.length, 3, 'Markdown 应保留 3 条有效记录');
assert.ok(markdown.issues.some((issue) => issue.message.includes('重复')));
assert.ok(markdown.issues.some((issue) => issue.message.includes('缺少宿舍号或姓名')));
assert.ok(markdown.issues.some((issue) => issue.message.includes('疑似公式')));

const html = parseTextRecords('宿舍号,姓名,班级\n101,<img onerror=alert(1)>,1班', 'html.csv');
assert.equal(html.rows[0].name, '<img onerror=alert(1)>');
assert.ok(!read('src/main.js').includes('innerHTML = `<div>${html.rows[0].name}</div>`'));

const formula = parseTextRecords('宿舍号,姓名,班级\n101,=HYPERLINK("x"),1班', 'formula.csv');
assert.equal(formula.rows.length, 0, '公式样式姓名不得进入名单');

const tooManyRows = Array.from({ length: MAX_IMPORT_ROWS + 20 }, (_, index) => `101,学生${index},${index},1班`).join('\n');
const limited = parseTextRecords(tooManyRows, 'large.txt');
assert.equal(limited.rows.length, MAX_IMPORT_ROWS, '导入行数应受上限保护');

const sourceFiles = [
  'src/main.js',
  'src/importer.mjs',
  'public/sw.js',
  'public/manifest.webmanifest',
  'index.html',
];
const source = sourceFiles.map(read).join('\n');
assert.ok(source.includes('createWorker'), '应包含本地 OCR worker 接入');
assert.ok(source.includes('/ocr/core'), 'OCR 应使用本地 core 路径');
assert.ok(read('public/sw.js').includes("catcheck-shell-v6"), '更新应切换离线缓存版本，避免继续使用旧界面资源');
assert.ok(source.includes('showDirectoryPicker'), '应包含可配置存档目录');
assert.ok(source.includes('image/png') && source.includes('image/jpeg'), '应包含 PNG/JPG 导出');
assert.ok(source.includes('bookType: \'xlsx\''), '应包含 Excel 导出');
assert.ok(source.includes('start-check-mode') && source.includes('room-select'), '应包含查寝模式和宿舍选择流程');
assert.ok(source.includes('save-and-next') && source.includes('reason-field'), '应包含逐寝保存和异常原因交互');
assert.ok(source.includes('top-nav') && !source.includes('bottom-nav'), '主导航应位于固定顶栏');
assert.ok(source.includes('open-commuter') && source.includes('toggle-commuter'), '应提供宿舍走读标记入口');
assert.ok(source.includes('isCommuter') && source.includes('isCommuter: item.isCommuter === true'), '走读标记应随本地备份恢复');
const recordFactory = read('src/main.js').match(/function createRecordFromStudent[\s\S]*?\n}\n\nfunction createDraft/);
assert.ok(recordFactory && !recordFactory[0].includes('isCommuter'), '走读标记不得写入查寝记录');
const reportBuilder = read('src/main.js').match(/function buildReport[\s\S]*?\n}\n\nfunction iconButton/);
assert.ok(reportBuilder && !reportBuilder[0].includes('isCommuter'), '走读标记不得影响汇报文字');
const roomActions = read('src/main.js').match(/<div class="manage-class-actions">[\s\S]*?<\/div>/);
assert.ok(roomActions, '宿舍卡片操作区缺失');
assert.ok(
  roomActions[0].indexOf('open-attendance') < roomActions[0].indexOf('delete-room')
    && roomActions[0].indexOf('delete-room') < roomActions[0].indexOf('open-commuter'),
  '走读入口应位于宿舍卡片第三个操作位',
);
assert.ok(read('src/style.css').includes('env(safe-area-inset-bottom)'), '底部操作应适配手机安全区');
assert.ok(read('src/style.css').includes('--native-bottom-inset'), '应支持 Android 原生底部安全区');
assert.ok(read('src/style.css').includes('position: sticky'), '顶栏应在页面滚动时固定');
assert.ok(source.includes('topbar-brand-row') && source.includes('topbar-title'), '顶栏应具有独立的标题层');
assert.ok(read('src/style.css').includes('grid-template-columns: repeat(3, minmax(0, 1fr))'), '顶栏功能区应为三等分按钮');
assert.ok(read('src/style.css').includes('position: static'), '查寝保存栏应处于学生名单后的正常文档流');
assert.ok(read('android/app/src/main/java/com/nos/classcheck/MainActivity.kt').includes('SOFT_INPUT_ADJUST_NOTHING'), '输入法弹出时不应挤压居中弹窗');
assert.ok(source.includes('normalizeViewState') && source.includes('normalizeStoredRecord'), '本地状态应在载入和渲染时归一化');
assert.ok(source.includes('VALID_STATUSES.has(target.dataset.status)'), '点名状态写入应拒绝非法状态');
assert.ok(read('android/app/src/main/java/com/nos/classcheck/MainActivity.kt').includes('navigationBarInsetBottom'), 'Android 应注入系统导航栏高度');
assert.ok(read('public/manifest.webmanifest').includes('喵喵查寝'), 'PWA 名称应使用喵喵查寝');
assert.ok(exists('public/icons/catcheck-icon.png'), 'CatCheck 应用图标缺失');
assert.ok(!/https?:\/\//i.test(source), '应用源码和本地资源不应包含外部 URL');

const fixtureFiles = [
  'tests/test-cases.md',
  'tests/test-cases.csv',
  'tests/fixtures/学生名单_正常.csv',
  'tests/fixtures/学生名单_文本.txt',
  'tests/fixtures/学生名单_异常与重复.md',
  'tests/fixtures/学生名单_图片.png',
  'tests/results/测试结果.md',
  'tests/results/security-scan.md',
];
fixtureFiles.forEach((file) => assert.ok(exists(file), `测试资料缺失：${file}`));

console.log('Static tests passed.');
console.log(`Parsed normal=${normal.rows.length}, text=${text.rows.length}, markdown=${markdown.rows.length}.`);
