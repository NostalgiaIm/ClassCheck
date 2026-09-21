import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_IMPORT_ROWS,
  parseTextRecords,
} from '../src/importer.mjs';
import { buildAttendanceReportModel } from '../src/report-model.mjs';
import { planReportImagePages, planReportXlsxSheet, renderReportMarkdown } from '../src/report-renderers.mjs';

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

const reportSession = (id, roomNo = 'A301', businessDate = '2026-09-20') => ({
  id,
  roomNo,
  businessDate,
  checkerName: '李老师',
  status: 'completed',
});
const reportRecord = (sessionId, studentId, status, extras = {}) => ({
  id: `${sessionId}_${studentId}_${extras.idSuffix || '1'}`,
  sessionId,
  studentId,
  status,
  updatedAt: extras.updatedAt || '2026-09-20T08:00:00.000Z',
  ...extras,
});
const reportInput = (overrides = {}) => ({
  scope: 'session',
  sessions: [reportSession('s1')],
  students: [
    { id: 'u1', name: '当前姓名甲', className: '当前班级', roomNo: 'A399' },
    { id: 'u2', name: '当前姓名乙', className: '当前班级', roomNo: 'A301' },
  ],
  records: [
    reportRecord('s1', 'u1', 'present', { studentNameSnapshot: '历史甲', classNameSnapshot: '历史班', roomNoSnapshot: 'A301', remark: '应清除' }),
    reportRecord('s1', 'u2', 'leave', { studentNameSnapshot: '历史乙', classNameSnapshot: '历史班', roomNoSnapshot: 'A301', remark: '病假' }),
  ],
  generatedAt: '2026-09-20T10:30:00.000Z',
  ...overrides,
});

const normalReport = buildAttendanceReportModel(reportInput());
assert.ok(normalReport.ok, '正常报告输入必须能够建模');
assert.deepEqual(normalReport.model.summary, { expected: 2, present: 1, absent: 0, leave: 1 });
assert.equal(normalReport.model.rows.find((row) => row.studentId === 'u1').name, '历史甲', '历史记录必须优先使用快照姓名');
assert.equal(normalReport.model.rows.find((row) => row.studentId === 'u1').roomNo, 'A301', '历史记录必须优先使用快照寝室');
assert.equal(normalReport.model.rows.find((row) => row.studentId === 'u1').remark, '', '到的学生不得保留导出备注');
assert.deepEqual(normalReport.model.exceptionRows.map((row) => row.studentId), ['u2']);

const duplicateReport = buildAttendanceReportModel(reportInput({
  records: [
    reportRecord('s1', 'u1', 'absent', { updatedAt: '2026-09-20T08:00:00.000Z' }),
    reportRecord('s1', 'u1', 'leave', { updatedAt: '2026-09-20T09:00:00.000Z', remark: '晚更新' }),
  ],
}));
assert.ok(duplicateReport.ok, '重复记录应可通过明确策略生成报告');
assert.equal(duplicateReport.model.rows.length, 1);
assert.equal(duplicateReport.model.rows[0].status, 'leave', '应保留更新时间更晚的重复记录');
assert.equal(duplicateReport.warnings[0].code, 'duplicate-record');
assert.equal(duplicateReport.warnings[0].details.resolution, 'latest-updated-at');

const invalidStatusReport = buildAttendanceReportModel(reportInput({ records: [reportRecord('s1', 'u1', 'unknown')] }));
assert.ok(!invalidStatusReport.ok);
assert.ok(invalidStatusReport.errors.some((error) => error.code === 'invalid-record'));

const duplicateSessionReport = buildAttendanceReportModel(reportInput({
  sessions: [reportSession('s1'), reportSession('s1')],
}));
assert.ok(!duplicateSessionReport.ok);
assert.ok(duplicateSessionReport.errors.some((error) => error.code === 'duplicate-session'));

const invalidSessionReport = buildAttendanceReportModel(reportInput({
  sessions: [{ ...reportSession('s1'), status: 'draft' }],
}));
assert.ok(!invalidSessionReport.ok);
assert.ok(invalidSessionReport.errors.some((error) => error.code === 'invalid-session'));

const unexpectedSessionReport = buildAttendanceReportModel(reportInput({
  records: [reportRecord('other-session', 'u1', 'present')],
}));
assert.ok(!unexpectedSessionReport.ok);
assert.ok(unexpectedSessionReport.errors.some((error) => error.code === 'unexpected-record-session'));

const malformedScopeReport = buildAttendanceReportModel(reportInput({ scope: 'other' }));
assert.ok(!malformedScopeReport.ok);
assert.ok(malformedScopeReport.errors.some((error) => error.code === 'invalid-scope'));


const mixedDateReport = buildAttendanceReportModel(reportInput({
  scope: 'check-mode',
  sessions: [reportSession('s1', 'A301', '2026-09-20'), reportSession('s2', 'A302', '2026-09-21')],
  records: [reportRecord('s1', 'u1', 'present'), reportRecord('s2', 'u2', 'absent')],
}));
assert.ok(!mixedDateReport.ok);
assert.ok(mixedDateReport.errors.some((error) => error.code === 'mixed-business-date'));

const renderedMarkdown = renderReportMarkdown(buildAttendanceReportModel(reportInput({ records: [
  reportRecord('s1', 'u1', 'absent', { studentNameSnapshot: '甲|乙', remark: '第一行\n第二行' }),
] })).model);
assert.ok(renderedMarkdown.includes('甲\\|乙') && renderedMarkdown.includes('第一行<br>第二行'), 'Markdown 单元格必须转义竖线和换行');

const formulaReport = buildAttendanceReportModel(reportInput({ records: [
  reportRecord('s1', 'u1', 'absent', { studentNameSnapshot: '=HYPERLINK("x")', remark: '+备注' }),
] }));
const xlsxPlan = planReportXlsxSheet(formulaReport.model);
assert.equal(xlsxPlan.rows[6][1], "'=HYPERLINK(\"x\")", 'XLSX 姓名必须作为文本写入');
assert.equal(xlsxPlan.rows[6][4], "'+备注", 'XLSX 备注必须作为文本写入');
assert.equal(xlsxPlan.autoFilterRef, 'A6:E7', '筛选范围只覆盖完整名单主表');
assert.ok(xlsxPlan.rows[xlsxPlan.exceptionTable.titleRowIndex][0].includes('异常明细'));

const pagedInput = (count) => reportInput({ records: Array.from({ length: count }, (_, index) => reportRecord('s1', `u${index}`, 'absent', { studentNameSnapshot: `学生${index}`, roomNoSnapshot: 'A301' })) });
assert.equal(planReportImagePages(buildAttendanceReportModel(pagedInput(0)).model).length, 1, '零异常也应产生摘要页');
assert.equal(planReportImagePages(buildAttendanceReportModel(pagedInput(20)).model).length, 1);
assert.equal(planReportImagePages(buildAttendanceReportModel(pagedInput(21)).model).length, 2);
const fortyOnePages = planReportImagePages(buildAttendanceReportModel(pagedInput(41)).model);
assert.equal(fortyOnePages.length, 3);
assert.ok(fortyOnePages[0].filename.endsWith('_第01页'));
assert.equal(fortyOnePages[2].rows.length, 1);
const sourceFiles = [
  'src/main.js',
  'src/importer.mjs',
  'src/report-model.mjs',
  'src/report-renderers.mjs',
  'src/sw.js',
  'index.html',
];
const source = sourceFiles.map(read).join('\n');
assert.ok(source.includes('createWorker'), '应包含本地 OCR worker 接入');
assert.ok(source.includes('/ocr/v1/core'), 'OCR 应使用版本化 v1 core 路径');
assert.ok(read('src/sw.js').includes("catcheck-shell-v8"), '更新应切换离线缓存版本，避免继续使用旧界面资源');
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
const reportModelSource = read('src/report-model.mjs');
assert.ok(reportModelSource.includes('buildAttendanceReportModel'), '应由独立报告模型生成导出数据');
assert.ok(!reportModelSource.includes('isCommuter'), '走读标记不得影响报告模型');
assert.ok(read('src/report-renderers.mjs').includes('planReportXlsxSheet'), 'Excel 应由结构化报告渲染器生成');
assert.ok(read('src/report-renderers.mjs').includes('planReportImagePages'), '图片报告应按页规划');
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
assert.ok(source.includes("if (record.status === 'present') record.remark = '';"), '学生恢复为到时应同步清除备注');
assert.ok(source.includes('renderReportDialog') && source.includes('report-warning-continue'), '重复记录导出应要求显式确认');
assert.ok(!source.includes("report.split('\\n')"), '报告导出不得再将文本按行伪装成表格');
assert.ok(read('android/app/src/main/java/com/nos/classcheck/MainActivity.kt').includes('navigationBarInsetBottom'), 'Android 应注入系统导航栏高度');
assert.ok(read('index.html').includes('manifest.webmanifest'), 'PWA 名称应在 manifest 中配置');
assert.ok(read('vite.config.js').includes("name: 'CatCheck'"), 'PWA manifest 应在 vite.config.js 中声明名称');
assert.ok(exists('public/icons/catcheck-icon.png'), 'CatCheck 应用图标缺失');
assert.ok(source.includes('check-app-update') && source.includes('checkForUpdate()'), '应提供内置更新源的检查入口');
assert.ok(!source.includes('update-manifest-url') && !source.includes('save-update-manifest'), '更新源不应向用户暴露可编辑地址');
const androidSource = [
  'android/app/src/main/java/com/nos/classcheck/MainActivity.kt',
  'android/app/src/main/java/com/nos/classcheck/UpdateManager.kt',
  'android/app/src/main/java/com/nos/classcheck/UpdateInstallReceiver.kt',
  'android/app/src/main/AndroidManifest.xml',
].map(read).join('\n');
assert.ok(androidSource.includes('REQUEST_INSTALL_PACKAGES') && androidSource.includes('PackageInstaller'), 'Android 应通过系统安装器请求更新');
assert.ok(androidSource.includes('sha256Of') && androidSource.includes('signingCertSha256'), '更新应校验 APK 摘要和签名证书');
assert.ok(androidSource.includes('isSafeHttpsUrl') && androidSource.includes('MAX_APK_BYTES'), '更新下载应限制 HTTPS 地址和文件大小');
assert.ok(androidSource.includes('fun check(): String') && androidSource.includes('UPDATE_MANIFEST_URL'), '原生更新器应使用内置更新清单地址');
assert.ok(!androidSource.includes('check(manifestUrl: String)'), '网页不应向原生更新器传入任意更新地址');
assert.ok(exists('tools/publish-update.ps1'), '应提供更新清单生成脚本');
assert.ok(exists('update-manifest.example.json'), '应提供更新清单模板');

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
