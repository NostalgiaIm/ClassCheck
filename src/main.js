import { createIcons, icons } from 'lucide';
import * as XLSX from 'xlsx';
import {
  MAX_IMPORT_ROWS,
  MAX_TEXT_LENGTH,
  importRowKey,
  normalizeImportRows,
  parseJsonRecords,
  parseTextRecords,
  sanitizeImportedValue,
} from './importer.mjs';
import { escapeMarkdownCell, safeSpreadsheetCell } from './export-utils.mjs';
import { buildAttendanceReportModel, createReportConfirmationFingerprint } from './report-model.mjs';
import {
  planReportImagePages,
  planReportXlsxSheet,
  renderReportImagePage,
  renderReportMarkdown,
  reportFileStem,
} from './report-renderers.mjs';
import { registerCatCheckPwa } from './pwa-register.js';
import './style.css';

const DB_NAME = 'dorm-check-local';
const DB_VERSION = 3;
const GITHUB_PROJECT_URL = 'https://github.com/NostalgiaIm/CatCheck';

const STORES = {
  students: 'students',
  sessions: 'sessions',
  records: 'records',
  settings: 'settings',
};

const STATUS_META = {
  present: { label: '到', icon: 'check', tone: 'present' },
  absent: { label: '未到', icon: 'x', tone: 'absent' },
  leave: { label: '请假', icon: 'file-check-2', tone: 'leave' },
};

const VALID_ROUTES = new Set(['home', 'history', 'manage', 'commuter', 'room-select', 'attendance', 'export']);
const VALID_STATUSES = new Set(Object.keys(STATUS_META));

const state = {
  route: 'home',
  students: [],
  sessions: [],
  records: [],
  checkerName: '',
  selectedRoomNo: '',
  commuterRoomNo: '',
  attendanceDate: todayString(),
  attendanceDraft: null,
  attendanceSearch: '',
  attendanceFilter: 'all',
  checkMode: null,
  startDialogOpen: false,
  joinDialogOpen: false,
  startDialogError: '',
  historyDate: '',
  historyRoomNo: '',
  historySelectedSessionId: '',
  importPreview: null,
  backupPreview: null,
  archiveDirectoryHandle: null,
  archiveDirectoryName: '',
  updateStatus: { state: 'idle', message: '' },
  updatePollTimer: null,
  ocrProgress: '',
  toastTimer: null,
  isBusy: false,
  reportDialog: null,
  confirmedReportFingerprints: new Set(),
  // PWA 更新管理
  pwaUpdateAvailable: false,
  pwaController: null,
  updateGuard: {
    isImporting: false,
    isRecognizingOcr: false,
    isRestoringBackup: false,
    isSaving: false,
    hasUnsavedAttendanceDraft: false,
  },
  // iOS 数据保护和存储
  iosStandaloneMode: false,
  lastActivityAt: null,
  backupReminderDismissedUntil: null,
  lastBackupTime: null,
  persistentStorageGranted: false,
  ocrOfflineReady: false,
  ocrCacheVersion: null,
  storageEstimate: { usage: 0, quota: 0 },
};

const app = document.querySelector('#app');
let dbPromise;
let ocrWorkerPromise;

// 活跃度节流：防止过于频繁地写入数据库
let lastActivityWriteTime = 0;
const ACTIVITY_WRITE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时

function todayString() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

function uid(prefix = 'id') {
  if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function formatDate(value, withWeekday = false) {
  if (!value) return '未选择日期';
  const [year, month, day] = value.split('-');
  const date = new Date(`${value}T12:00:00`);
  const weekday = withWeekday ? ` ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]}` : '';
  return `${year}年${Number(month)}月${Number(day)}日${weekday}`;
}

function formatReportDate(value) {
  const [, month, day] = value.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + ' ' + sizes[i];
}

function normalizeRoomNo(value) {
  return String(value || '').trim() || '未分配';
}

function normalizeClassName(value) {
  return String(value || '').trim() || '未分班';
}

const OCR_ASSET_PATHS = {
  worker: '/ocr/v1/worker.min.js',
  core: '/ocr/v1/core',
  lang: '/ocr/v1/lang',
  coreFile: '/ocr/v1/core/tesseract-core.wasm.js',
  chiLang: '/ocr/v1/lang/chi_sim.traineddata.gz',
  engLang: '/ocr/v1/lang/eng.traineddata.gz',
};

function resolveLocalAssetUrl(path) {
  return new URL(String(path).replace(/^(?:\.\/|\/)+/, ''), document.baseURI).href;
}


function getNativeAppInfo() {
  const bridge = window.AndroidFileBridge;
  if (!bridge || typeof bridge.getAppInfo !== 'function') return null;
  try {
    const info = JSON.parse(bridge.getAppInfo());
    if (!Number.isFinite(Number(info.versionCode)) || !String(info.versionName || '').trim()) return null;
    return { versionCode: Number(info.versionCode), versionName: String(info.versionName).trim() };
  } catch {
    return null;
  }
}

function supportsNativeUpdate() {
  const bridge = window.AndroidFileBridge;
  return Boolean(
    bridge
      && typeof bridge.checkForUpdate === 'function'
      && typeof bridge.installAvailableUpdate === 'function'
      && typeof bridge.getUpdateStatus === 'function'
      && getNativeAppInfo(),
  );
}

/**
 * 检测 iOS standalone 模式（已添加到主屏幕）
 * 在启动和 visibilitychange 时调用以更新状态
 */
function checkIosStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

/**
 * 请求持久化存储权限
 * @returns {Promise<boolean>} 是否授予
 */
async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) {
      console.info('[Storage] Persistent storage not supported');
      return false;
    }
    const granted = await navigator.storage.persist();
    console.info('[Storage] Persistent storage request:', granted ? 'granted' : 'denied');
    return granted;
  } catch (error) {
    console.error('[Storage] Failed to request persistent storage:', error);
    return false;
  }
}

/**
 * 更新存储容量估计
 * @returns {Promise<{usage: number, quota: number}>}
 */
async function updateStorageEstimate() {
  try {
    if (!navigator.storage?.estimate) {
      console.info('[Storage] Storage estimate not supported');
      return { usage: 0, quota: 0 };
    }
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch (error) {
    console.error('[Storage] Failed to estimate storage:', error);
    return { usage: 0, quota: 0 };
  }
}

/**
 * 计算 SHA-256 哈希（用于备份完整性校验）
 * @param {string} data 数据字符串
 * @returns {Promise<string>} 十六进制哈希
 */
async function sha256(data) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 记录有意义的活动（带节流）
 * 应在保存、导入、恢复等重要操作后调用
 * @returns {Promise<void>}
 */
async function recordMeaningfulActivity() {
  const now = Date.now();
  if (now - lastActivityWriteTime < ACTIVITY_WRITE_INTERVAL_MS) {
    return; // 节流中，不写入
  }

  try {
    const timestamp = new Date(now).toISOString();
    await dbPut(STORES.settings, {
      key: 'lastActivityAt',
      value: timestamp,
    });
    state.lastActivityAt = new Date(timestamp);
    lastActivityWriteTime = now;
    console.info('[Activity] Recorded at', timestamp);
  } catch (error) {
    console.error('[Activity] Failed to record:', error);
  }
}

function isValidBusinessDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeStatus(value) {
  return VALID_STATUSES.has(value) ? value : 'present';
}

function normalizeRoute(value) {
  return VALID_ROUTES.has(value) ? value : 'home';
}

function normalizeStoredStudent(item) {
  if (!item || typeof item !== 'object') return null;
  const id = sanitizeImportedValue(item.id, 120);
  const name = sanitizeImportedValue(item.name, 120);
  if (!id || !name) return null;
  return {
    ...item,
    id,
    roomNo: normalizeRoomNo(sanitizeImportedValue(item.roomNo, 80)),
    name,
    className: normalizeClassName(sanitizeImportedValue(item.className, 120)),
    isActive: item.isActive !== false,
    isCommuter: item.isCommuter === true,
  };
}

function normalizeStoredSession(item) {
  if (!item || typeof item !== 'object') return null;
  const id = sanitizeImportedValue(item.id, 120);
  if (!id || !isValidBusinessDate(item.businessDate)) return null;
  return {
    ...item,
    id,
    roomNo: normalizeRoomNo(sanitizeImportedValue(item.roomNo, 80)),
    businessDate: item.businessDate,
    checkerName: sanitizeImportedValue(item.checkerName, 40),
    status: item.status === 'completed' ? 'completed' : 'draft',
  };
}

function normalizeStoredRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const id = sanitizeImportedValue(item.id, 120);
  const sessionId = sanitizeImportedValue(item.sessionId, 120);
  const studentId = sanitizeImportedValue(item.studentId, 120);
  if (!id || !sessionId || !studentId) return null;
  return {
    ...item,
    id,
    sessionId,
    studentId,
    status: normalizeStatus(item.status),
    remark: sanitizeImportedValue(item.remark, 80),
  };
}

function normalizeViewState() {
  state.route = normalizeRoute(state.route);
  state.attendanceDate = isValidBusinessDate(state.attendanceDate) ? state.attendanceDate : todayString();
  state.attendanceFilter = VALID_STATUSES.has(state.attendanceFilter) ? state.attendanceFilter : 'all';
  state.historyDate = !state.historyDate || isValidBusinessDate(state.historyDate) ? state.historyDate : '';

  if (state.checkMode && typeof state.checkMode === 'object') {
    state.checkMode = {
      ...state.checkMode,
      date: isValidBusinessDate(state.checkMode.date) ? state.checkMode.date : state.attendanceDate,
      checkerName: sanitizeImportedValue(state.checkMode.checkerName, 40),
      sessionIds: Array.isArray(state.checkMode.sessionIds)
        ? [...new Set(state.checkMode.sessionIds.map((id) => sanitizeImportedValue(id, 120)).filter(Boolean))]
        : [],
    };
  } else {
    state.checkMode = null;
  }

  const roomExists = (roomNo) => getRooms().some((room) => room.roomNo === normalizeRoomNo(roomNo));
  if (state.route === 'attendance' && (!state.attendanceDraft || !roomExists(state.selectedRoomNo))) {
    state.attendanceDraft = null;
    state.selectedRoomNo = '';
    state.route = state.checkMode ? 'room-select' : 'home';
  }
  if (state.route === 'room-select' && !state.checkMode) state.route = 'home';
  if (state.route === 'export' && (!state.checkMode || !getCheckModeSessions().length)) state.route = state.checkMode ? 'room-select' : 'home';
  if (state.route === 'commuter' && !roomExists(state.commuterRoomNo)) state.route = 'manage';
  if (state.historySelectedSessionId && !state.sessions.some((session) => session.id === state.historySelectedSessionId)) {
    state.historySelectedSessionId = '';
  }
}

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = request.result;
      const upgradeTransaction = request.transaction;
      const oldVersion = event.oldVersion;

      if (!database.objectStoreNames.contains(STORES.students)) {
        const students = database.createObjectStore(STORES.students, { keyPath: 'id' });
        students.createIndex('roomNo', 'roomNo', { unique: false });
        students.createIndex('studentKey', ['roomNo', 'name', 'className'], { unique: false });
      } else if (oldVersion < 3) {
        const students = upgradeTransaction.objectStore(STORES.students);
        if (students.indexNames.contains('studentKey')) students.deleteIndex('studentKey');
        students.createIndex('studentKey', ['roomNo', 'name', 'className'], { unique: false });
        const cursorRequest = students.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const cleanStudent = { ...cursor.value };
          delete cleanStudent.studentNo;
          cursor.update(cleanStudent);
          cursor.continue();
        };
      }

      if (!database.objectStoreNames.contains(STORES.sessions)) {
        const sessions = database.createObjectStore(STORES.sessions, { keyPath: 'id' });
        sessions.createIndex('roomDate', ['roomNo', 'businessDate'], { unique: true });
        sessions.createIndex('businessDate', 'businessDate', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.records)) {
        const records = database.createObjectStore(STORES.records, { keyPath: 'id' });
        records.createIndex('sessionId', 'sessionId', { unique: false });
        records.createIndex('sessionStudent', ['sessionId', 'studentId'], { unique: true });
      } else if (oldVersion < 3) {
        const records = upgradeTransaction.objectStore(STORES.records);
        const cursorRequest = records.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const cleanRecord = { ...cursor.value };
          delete cleanRecord.studentNoSnapshot;
          cursor.update(cleanRecord);
          cursor.continue();
        };
      }

      if (!database.objectStoreNames.contains(STORES.settings)) {
        database.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function dbGetAll(storeName) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(storeName, key) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(storeName, value) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

async function dbPutMany(storeName, values) {
  if (!values.length) return;
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    values.forEach((value) => store.put(value));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('本地事务已中止'));
  });
}

async function dbReplaceSessionRecords(sessionId, records) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORES.records, 'readwrite');
    const store = transaction.objectStore(STORES.records);
    const request = store.index('sessionId').openCursor(IDBKeyRange.only(sessionId));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      records.forEach((record) => store.put(record));
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('本地事务已中止'));
  });
}

async function dbDelete(storeName, key) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function dbClear(storeName) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readwrite').objectStore(storeName).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function refreshData() {
  const [students, sessions, records, checkerSetting, archiveSetting] = await Promise.all([
    dbGetAll(STORES.students),
    dbGetAll(STORES.sessions),
    dbGetAll(STORES.records),
    dbGet(STORES.settings, 'checkerName'),
    dbGet(STORES.settings, 'archiveDirectory'),
  ]);

  const cleanStudents = students.map(normalizeStoredStudent).filter(Boolean);
  const studentIds = new Set(cleanStudents.map((student) => student.id));
  const cleanSessions = sessions.map(normalizeStoredSession).filter(Boolean);
  const sessionIds = new Set(cleanSessions.map((session) => session.id));
  const cleanRecords = records
    .map(normalizeStoredRecord)
    .filter((record) => record && sessionIds.has(record.sessionId) && studentIds.has(record.studentId));

  state.students = sortStudents(cleanStudents);
  state.sessions = cleanSessions.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || compareText(a.roomNo, b.roomNo));
  state.records = cleanRecords;
  state.checkerName = checkerSetting?.value || '';
  state.archiveDirectoryHandle = archiveSetting?.value || null;
  state.archiveDirectoryName = archiveSetting?.name || '';

  normalizeViewState();
}

function sortStudents(students) {
  return [...students].sort((a, b) => {
    const room = compareText(a.roomNo, b.roomNo);
    if (room !== 0) return room;
    const klass = compareText(a.className, b.className);
    if (klass !== 0) return klass;
    return compareText(a.name, b.name);
  });
}

function getRooms() {
  const map = new Map();
  state.students
    .filter((student) => student.isActive !== false)
    .forEach((student) => {
      const roomNo = normalizeRoomNo(student.roomNo);
      if (!map.has(roomNo)) {
        map.set(roomNo, { roomNo, students: [] });
      }
      map.get(roomNo).students.push(student);
    });

  return [...map.values()].sort((a, b) => compareText(a.roomNo, b.roomNo));
}

function getRoomStudents(roomNo, activeOnly = true) {
  return sortStudents(
    state.students.filter((student) => normalizeRoomNo(student.roomNo) === normalizeRoomNo(roomNo) && (!activeOnly || student.isActive !== false)),
  );
}

function getSession(roomNo, date) {
  return state.sessions.find((session) => normalizeRoomNo(session.roomNo) === normalizeRoomNo(roomNo) && session.businessDate === date);
}

function getSessionRecords(sessionId) {
  return state.records.filter((record) => record.sessionId === sessionId);
}

function getCounts(records) {
  return records.reduce(
    (counts, record) => {
      const status = normalizeStatus(record?.status);
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    },
    { present: 0, absent: 0, leave: 0 },
  );
}

function iconButton(icon, label, action, extra = '') {
  return `<button class="icon-button ${extra}" type="button" data-action="${action}" aria-label="${label}" title="${label}">
    <i data-lucide="${icon}" aria-hidden="true"></i>
  </button>`;
}

function statusButton(status, selected) {
  const meta = STATUS_META[status];
  return `
    <button class="status-button status-${meta.tone}${selected ? ' is-selected' : ''}" type="button" data-action="set-status" data-status="${status}" title="标记为${meta.label}">
      <i data-lucide="${meta.icon}" aria-hidden="true"></i>
      <span>${meta.label}</span>
    </button>
  `;
}

function renderShell(content) {
  const navItems = [
    ['home', 'layout-dashboard', '今日'],
    ['history', 'history', '历史'],
    ['manage', 'list-plus', '名单'],
  ];

  const pwaUpdateBanner = state.pwaUpdateAvailable
    ? `
      <div class="pwa-update-banner" role="alert">
        <div class="banner-content">
          <p><strong>新版本可用</strong> — 应用已更新，点击安装获得最新功能和修复。</p>
        </div>
        <button type="button" class="banner-action-button" data-action="install-pwa-update">
          <span>安装</span>
          <i data-lucide="download" aria-hidden="true"></i>
        </button>
      </div>
    `
    : '';

  // 计算是否应该显示备份提醒
  let backupReminderBanner = '';
  if (state.lastActivityAt) {
    const lastActivityTime = new Date(state.lastActivityAt);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const dismissedUntil = state.backupReminderDismissedUntil ? new Date(state.backupReminderDismissedUntil) : null;
    const now = new Date();

    // 如果最后活动时间超过 5 天，且未被最近关闭，则显示提醒
    if (lastActivityTime < fiveDaysAgo && (!dismissedUntil || dismissedUntil < now)) {
      backupReminderBanner = `
        <div class="backup-reminder-banner" role="alert">
          <div class="banner-content">
            <p><strong>建议备份</strong> — 已有 5 天未备份本地数据。点击导出备份以防止数据丢失。</p>
          </div>
          <div class="banner-actions">
            <button type="button" class="text-button" data-action="dismiss-backup-reminder">暂不</button>
            <button type="button" class="primary-button" data-action="navigate" data-route="manage">
              <span>导出备份</span>
              <i data-lucide="download" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      `;
    }
  }

  // 计算存储配额百分比
  let storageQuotaBanner = '';
  if (state.iosStandaloneMode && state.storageEstimate.quota > 0) {
    const usagePercent = Math.round((state.storageEstimate.usage / state.storageEstimate.quota) * 100);
    if (usagePercent > 80) {
      storageQuotaBanner = `
        <div class="storage-quota-banner warning" role="alert">
          <div class="banner-content">
            <p><strong>存储空间即将满</strong> — 已使用 ${usagePercent}% 的本地存储 (${formatBytes(state.storageEstimate.usage)} / ${formatBytes(state.storageEstimate.quota)})。</p>
          </div>
          <button type="button" class="banner-action-button" data-action="navigate" data-route="manage">
            <span>清理数据</span>
            <i data-lucide="trash-2" aria-hidden="true"></i>
          </button>
        </div>
      `;
    }
  }

  return `
    <div class="app-shell">
      ${pwaUpdateBanner}
      ${backupReminderBanner}
      ${storageQuotaBanner}
      <header class="topbar">
        <div class="topbar-brand-row">
          <div class="brand-mark"><img src="icons/catcheck-icon.png" alt="" /></div>
          <h1 class="topbar-title">喵喵查寝</h1>
          <button class="github-button" type="button" data-action="open-join-dialog" aria-label="加入我们" title="加入我们">
            <i data-lucide="github" aria-hidden="true"></i>
          </button>
        </div>
        <nav class="top-nav" aria-label="主导航">
          ${navItems
            .map(
              ([route, icon, label]) => `
              <button type="button" class="nav-item${state.route === route ? ' is-active' : ''}" data-action="navigate" data-route="${route}">
                <span class="nav-item-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
                <span class="nav-item-label">${label}</span>
              </button>`,
            )
            .join('')}
        </nav>
      </header>
      <main class="main-content">${content}</main>
      <div id="toast-root" aria-live="polite"></div>
      ${state.startDialogOpen ? renderStartDialog() : ''}
      ${state.joinDialogOpen ? renderJoinDialog() : ''}
      ${renderReportDialog()}
    </div>
  `;
}

function renderStartDialog() {
  return `
    <div class="modal-scrim" role="presentation">
      <section class="md-dialog" role="dialog" aria-modal="true" aria-labelledby="start-check-title">
        <div class="dialog-icon"><i data-lucide="user-round-check" aria-hidden="true"></i></div>
        <h2 id="start-check-title">开始查寝</h2>
        <p>请输入本次查寝人姓名，保存后将进入宿舍选择。</p>
        <label class="field-label dialog-field">查寝人姓名
          <input type="text" id="start-checker-name" value="${escapeHtml(state.checkerName)}" maxlength="20" placeholder="例如：查寝员甲" autofocus />
        </label>
        ${state.startDialogError ? `<p class="dialog-error"><i data-lucide="circle-alert"></i>${escapeHtml(state.startDialogError)}</p>` : ''}
        <div class="dialog-actions">
          <button class="text-button" type="button" data-action="cancel-start-check">取消</button>
          <button class="primary-button" type="button" data-action="confirm-start-check"><i data-lucide="play"></i><span>进入查寝</span></button>
        </div>
      </section>
    </div>
  `;
}

function renderJoinDialog() {
  return `
    <div class="modal-scrim" role="presentation">
      <section class="md-dialog join-dialog" role="dialog" aria-modal="true" aria-labelledby="join-dialog-title">
        <div class="dialog-icon join-dialog-icon"><i data-lucide="github" aria-hidden="true"></i></div>
        <h2 id="join-dialog-title">加入我们</h2>
        <p>欢迎一起完善喵喵查寝。项目地址已放在下方按钮中，点击即可打开项目仓库。</p>
        <div class="dialog-actions">
          <button class="text-button" type="button" data-action="close-join-dialog">取消</button>
          <button class="primary-button" type="button" data-action="open-project"><i data-lucide="external-link"></i><span>查看项目</span></button>
        </div>
      </section>
    </div>
  `;
}

function renderHome() {
  const rooms = getRooms();
  const todaySessions = state.sessions.filter((session) => session.businessDate === state.attendanceDate);
  const completed = todaySessions.filter((session) => session.status === 'completed').length;
  const totalStudents = state.students.filter((student) => student.isActive !== false).length;

  const startPanel = rooms.length
    ? `
      <section class="today-start-panel">
        <div class="start-panel-icon"><i data-lucide="clipboard-pen-line"></i></div>
        <p class="section-kicker">CHECK MODE</p>
        <h2>准备开始今天的查寝</h2>
        <p>输入查寝人姓名后，按宿舍逐个完成点名。</p>
        <button class="primary-button start-check-button" type="button" data-action="start-check-mode">
          <i data-lucide="play"></i><span>开始查寝</span>
        </button>
      </section>
    `
    : `
      <div class="empty-state empty-state-large">
        <div class="empty-icon"><i data-lucide="file-spreadsheet"></i></div>
        <h3>还没有宿舍名单</h3>
        <p>导入名单后，才能开始查寝。</p>
        <button class="primary-button" type="button" data-action="navigate" data-route="manage">
          <i data-lucide="upload"></i><span>导入名单</span>
        </button>
      </div>
    `;

  return `
    <section class="hero-section">
      <div>
        <p class="section-kicker">TODAY'S CHECK</p>
        <h2>${formatDate(state.attendanceDate, true)}</h2>
        <p class="hero-note">本次查寝按宿舍号进行，默认全员到，只处理异常人员。</p>
      </div>
      <button class="date-control" type="button" data-action="pick-home-date" title="选择查寝日期">
        <i data-lucide="calendar-days"></i>
        <span>${formatDate(state.attendanceDate)}</span>
        <i data-lucide="chevron-down" class="small-icon"></i>
        <input class="visually-hidden" type="date" id="home-date-input" value="${state.attendanceDate}" />
      </button>
    </section>
    <section class="overview-strip">
      <div class="overview-stat">
        <span class="stat-label">今日进度</span>
        <strong>${completed}<small> / ${rooms.length}</small></strong>
        <span class="stat-meta">个宿舍已完成</span>
      </div>
      <div class="overview-stat">
        <span class="stat-label">名单人数</span>
        <strong>${totalStudents}</strong>
        <span class="stat-meta">名有效学生</span>
      </div>
      <div class="overview-stat overview-stat-note">
        <span class="stat-label">操作方式</span>
        <strong>逐寝完成</strong>
        <span class="stat-meta">结束后统一导出</span>
      </div>
    </section>
    <section class="content-section today-start-section">
      ${startPanel}
    </section>
    <section class="quick-section" aria-label="快捷入口">
      <h2>快捷入口</h2>
      <div class="quick-entry-list">
        <button class="quick-entry-card" type="button" data-action="navigate" data-route="manage">
          <span class="quick-entry-icon"><i data-lucide="list-plus" aria-hidden="true"></i></span>
          <span><strong>管理名单</strong><small>导入 / 识别 / 导出名单</small></span>
          <i data-lucide="chevron-right" aria-hidden="true"></i>
        </button>
        <button class="quick-entry-card" type="button" data-action="navigate" data-route="history">
          <span class="quick-entry-icon"><i data-lucide="history" aria-hidden="true"></i></span>
          <span><strong>历史记录</strong><small>查看本机保存的查寝结果</small></span>
          <i data-lucide="chevron-right" aria-hidden="true"></i>
        </button>
      </div>
    </section>
  `;
}

function renderRoomSelect() {
  const rooms = getRooms();
  const mode = state.checkMode;
  const completedRooms = new Set(mode?.sessionIds || []);
  const completedRoomNos = new Set(
    state.sessions.filter((session) => completedRooms.has(session.id)).map((session) => session.roomNo),
  );
  return `
    <section class="page-header mode-header">
      <button class="back-button" type="button" data-action="navigate" data-route="home" title="返回今日"><i data-lucide="arrow-left"></i></button>
      <div class="page-header-copy">
        <p class="section-kicker">CHECK MODE</p>
        <h2>选择宿舍</h2>
        <p>${formatDate(mode?.date || state.attendanceDate, true)} · 查寝人 ${escapeHtml(mode?.checkerName || state.checkerName)}</p>
      </div>
      <button class="secondary-button finish-check-button" type="button" data-action="end-check-mode"><i data-lucide="square"></i><span>结束查寝</span></button>
    </section>
    <section class="mode-progress">
      <div><strong>${completedRoomNos.size}</strong><span>已完成</span></div>
      <div><strong>${rooms.length}</strong><span>全部宿舍</span></div>
      <div class="mode-progress-bar"><span style="width:${rooms.length ? Math.round((completedRoomNos.size / rooms.length) * 100) : 0}%"></span></div>
    </section>
    <section class="room-select-section">
      <div class="section-heading"><div><p class="section-kicker">DORM LIST</p><h2>选择要查的寝室</h2></div></div>
      <div class="class-list">
        ${rooms.map((room, index) => {
          const session = getSession(room.roomNo, mode?.date || state.attendanceDate);
          const checked = completedRoomNos.has(room.roomNo) || session?.status === 'completed';
          return `<button class="class-card${checked ? ' is-complete' : ''}" type="button" data-action="open-attendance" data-room-no="${escapeHtml(room.roomNo)}">
            <div class="class-card-main"><span class="class-index">${String(index + 1).padStart(2, '0')}</span><div><h3>${escapeHtml(room.roomNo)} 寝</h3><p>${room.students.length} 人</p></div></div>
            <div class="class-card-status">${checked ? '<span class="completion-chip"><i data-lucide="check-circle-2"></i>已完成</span>' : '<span class="pending-chip">待查</span>'}<i data-lucide="chevron-right" class="chevron"></i></div>
          </button>`;
        }).join('')}
      </div>
    </section>
  `;
}

function renderReportActions() {
  return `
    <div class="report-actions">
      <button class="secondary-button report-action" type="button" data-action="copy-report">
        <i data-lucide="copy"></i><span>复制</span>
      </button>
      <button class="secondary-button report-action" type="button" data-action="export-report" data-format="md">
        <i data-lucide="file-text"></i><span>文字</span>
      </button>
      <button class="secondary-button report-action" type="button" data-action="export-report" data-format="png">
        <i data-lucide="image"></i><span>PNG</span>
      </button>
      <button class="secondary-button report-action" type="button" data-action="export-report" data-format="jpg">
        <i data-lucide="image"></i><span>JPG</span>
      </button>
      <button class="secondary-button report-action" type="button" data-action="export-report" data-format="xlsx">
        <i data-lucide="sheet"></i><span>Excel</span>
      </button>
    </div>
  `;
}

function buildReportInput(scope, sessions, generatedAt = new Date().toISOString()) {
  const selectedSessions = Array.isArray(sessions) ? sessions : [];
  const sessionIds = new Set(selectedSessions.map((session) => session?.id));
  const useDraftRecords =
    scope === 'session' &&
    state.route === 'attendance' &&
    state.attendanceDraft?.id === selectedSessions[0]?.id;

  return {
    scope,
    sessions: selectedSessions,
    records: useDraftRecords
      ? state.attendanceDraft.records
      : state.records.filter((record) => sessionIds.has(record.sessionId)),
    students: state.students,
    generatedAt,
  };
}

function buildReportResult(scope, sessions) {
  return buildAttendanceReportModel(buildReportInput(scope, sessions));
}

function reportPreviewText(result, emptyMessage = '暂无已保存的查寝结果') {
  if (result?.ok) return renderReportMarkdown(result.model);
  if (!result?.errors?.length) return emptyMessage;
  return `报告暂不可生成\n\n${result.errors.map((error) => `• ${error.code}：${error.message}`).join('\n')}`;
}

function currentSingleReportDescriptor(format = 'md') {
  if (state.route === 'attendance' && state.attendanceDraft) {
    return { scope: 'session', sessionIds: [state.attendanceDraft.id], format };
  }
  if (state.historySelectedSessionId) {
    return { scope: 'session', sessionIds: [state.historySelectedSessionId], format };
  }
  return null;
}

function checkModeReportDescriptor(format = 'md') {
  return { scope: 'check-mode', sessionIds: getCheckModeSessions().map((session) => session.id), format };
}

function sessionsForReportDescriptor(descriptor) {
  const ids = new Set(descriptor?.sessionIds || []);
  if (!ids.size) return [];
  return [...ids]
    .map((id) => {
      if (descriptor.scope === 'session' && state.route === 'attendance' && state.attendanceDraft?.id === id) {
        return state.attendanceDraft;
      }
      return state.sessions.find((session) => session.id === id);
    })
    .filter(Boolean);
}

function buildReportFromDescriptor(descriptor) {
  return buildReportResult(descriptor?.scope, sessionsForReportDescriptor(descriptor));
}

function renderAttendance() {
  const students = getRoomStudents(state.selectedRoomNo);
  const draft = state.attendanceDraft || { records: [] };
  const recordsByStudent = new Map(draft.records.map((record) => [record.studentId, record]));
  const allRecords = students.map((student) => recordsByStudent.get(student.id) || createRecordFromStudent(student, draft.id));
  const counts = getCounts(allRecords);
  const search = state.attendanceSearch.trim().toLowerCase();
  const filtered = students.filter((student) => {
    const text = `${student.name} ${student.className || ''} ${student.roomNo || ''}`.toLowerCase();
    const record = recordsByStudent.get(student.id) || { status: 'present' };
    const matchesSearch = !search || text.includes(search);
    const matchesFilter = state.attendanceFilter === 'all' || normalizeStatus(record.status) === state.attendanceFilter;
    return matchesSearch && matchesFilter;
  });
  const reportResult = draft?.status === 'completed' ? buildReportResult('session', [draft]) : null;
  const reportText = reportResult ? reportPreviewText(reportResult) : '';

  const list = filtered.length
    ? filtered
        .map((student) => {
          const record = recordsByStudent.get(student.id) || { studentId: student.id, status: 'present', remark: '' };
          const recordStatus = normalizeStatus(record.status);
          const statusMeta = STATUS_META[recordStatus];
          return `
            <article class="student-row status-row-${statusMeta.tone}" data-student-id="${student.id}">
              <div class="student-identity">
                <span class="room-badge">${escapeHtml(student.className || '未分班')}</span>
                <div>
                  <h3>${escapeHtml(student.name)}</h3>
                  <p>${escapeHtml(student.roomNo)} 寝</p>
                </div>
              </div>
              <div class="student-actions">
                <div class="status-actions">
                  ${Object.keys(STATUS_META).map((status) => statusButton(status, recordStatus === status)).join('')}
                </div>
                ${recordStatus !== 'present' ? `<label class="reason-field reason-field-${recordStatus}">${recordStatus === 'leave' ? '请假原因' : '未到原因'}
                  <input type="text" data-role="remark" data-student-id="${student.id}" value="${escapeHtml(record.remark || '')}" placeholder="请输入原因" maxlength="80" />
                </label>` : ''}
              </div>
            </article>
          `;
        })
        .join('')
    : `<div class="empty-state"><div class="empty-icon"><i data-lucide="search-x"></i></div><h3>没有匹配的学生</h3><p>试试其他搜索词或取消筛选。</p></div>`;

  return `
    <section class="page-header attendance-header">
      <button class="back-button" type="button" data-action="navigate" data-route="home" title="返回今日">
        <i data-lucide="arrow-left"></i>
      </button>
      <div class="page-header-copy">
        <p class="section-kicker">ATTENDANCE</p>
        <h2>${escapeHtml(state.selectedRoomNo || '未选择宿舍')} 寝</h2>
        <p>${formatDate(state.attendanceDate, true)} · ${students.length} 名学生</p>
      </div>
      <span class="local-pill"><i data-lucide="hard-drive"></i>本机</span>
    </section>
    <section class="attendance-toolbar">
      <div class="attendance-summary">
        <div class="summary-total"><strong>${students.length}</strong><span>应到</span></div>
        <div class="summary-value present"><strong>${counts.present}</strong><span>实到</span></div>
        <div class="summary-value absent"><strong>${counts.absent}</strong><span>未到</span></div>
        <div class="summary-value leave"><strong>${counts.leave}</strong><span>请假</span></div>
      </div>
      <button class="all-present-button" type="button" data-action="mark-all-present">
        <i data-lucide="check-check"></i><span>一键全到</span>
      </button>
    </section>
    <section class="list-controls">
      <label class="search-field">
        <i data-lucide="search"></i>
        <input type="search" id="attendance-search" value="${escapeHtml(state.attendanceSearch)}" placeholder="搜索姓名或班级" />
        ${state.attendanceSearch ? `<button type="button" data-action="clear-attendance-search" aria-label="清除搜索"><i data-lucide="x"></i></button>` : ''}
      </label>
      <div class="filter-tabs">
        ${[['all', '全部'], ['absent', '未到'], ['leave', '请假']].map(([filter, label]) => {
          const active = state.attendanceFilter === filter;
          return `<button type="button" class="${active ? 'is-active' : ''}" data-action="filter-attendance" data-filter="${filter}">${active ? '<i data-lucide="check" aria-hidden="true"></i>' : ''}${label}</button>`;
        }).join('')}
      </div>
    </section>
    <section class="student-list-section">
      <div class="list-heading"><span>宿舍成员</span><span>${filtered.length} 人显示中</span></div>
      <div class="student-list">${list}</div>
      <div class="save-bar" aria-label="查寝保存操作">
        <button class="secondary-button" type="button" data-action="save-attendance"><i data-lucide="save"></i><span>保存</span></button>
        <button class="primary-button save-button" type="button" data-action="save-and-next"><i data-lucide="${state.checkMode ? 'arrow-right' : 'save'}"></i><span>${state.checkMode ? '下一个寝室' : '更新保存'}</span></button>
      </div>
      ${reportText ? `<div class="report-panel"><div class="detail-header"><div><p class="section-kicker">REPORT MODEL</p><h3>报告预览</h3></div>${renderReportActions()}</div><pre id="report-text">${escapeHtml(reportText)}</pre></div>` : ''}
    </section>
  `;
}

function getCheckModeSessions() {
  const date = state.checkMode?.date || state.attendanceDate;
  const ids = new Set(state.checkMode?.sessionIds || []);
  return state.sessions.filter((session) => session.businessDate === date && ids.has(session.id));
}

function renderExport() {
  const sessions = getCheckModeSessions();
  const reportResult = buildReportResult('check-mode', sessions);
  const text = reportPreviewText(reportResult);
  return `
    <section class="page-header export-header">
      <button class="back-button" type="button" data-action="navigate" data-route="room-select" title="返回宿舍选择"><i data-lucide="arrow-left"></i></button>
      <div class="page-header-copy"><p class="section-kicker">EXPORT</p><h2>导出查寝结果</h2><p>${formatDate(state.checkMode?.date || state.attendanceDate, true)} · ${sessions.length} 个宿舍</p></div>
      <span class="local-pill"><i data-lucide="hard-drive-download"></i>本机生成</span>
    </section>
    <section class="export-summary-card"><div class="export-summary-icon"><i data-lucide="file-check-2"></i></div><div><strong>本次查寝已结束</strong><p>所有格式均从同一份报告模型生成，统计与异常名单保持一致。</p></div></section>
    <section class="report-panel export-report-panel"><div class="detail-header"><div><p class="section-kicker">PREVIEW</p><h3>报告预览</h3></div><button class="secondary-button" type="button" data-action="copy-check-results"><i data-lucide="copy"></i><span>复制全部</span></button></div><pre id="report-text">${escapeHtml(text)}</pre></section>
    <section class="export-format-section"><div class="section-heading"><div><p class="section-kicker">FORMAT</p><h2>选择生成格式</h2></div></div><div class="export-actions export-actions-large">
      <button class="export-action" type="button" data-action="export-check-results" data-format="md"><i data-lucide="file-text"></i><span>文字 / Markdown</span></button>
      <button class="export-action" type="button" data-action="export-check-results" data-format="png"><i data-lucide="image"></i><span>PNG 图片</span></button>
      <button class="export-action" type="button" data-action="export-check-results" data-format="jpg"><i data-lucide="image"></i><span>JPG 图片</span></button>
      <button class="export-action" type="button" data-action="export-check-results" data-format="xlsx"><i data-lucide="sheet"></i><span>Excel 表格</span></button>
    </div></section>
    <div class="export-finish-bar"><button class="primary-button" type="button" data-action="finish-check-mode"><i data-lucide="check"></i><span>完成并返回今日</span></button></div>
  `;
}

function renderHistory() {
  const rooms = getRooms();
  const filteredSessions = state.sessions.filter((session) => {
    const matchesDate = !state.historyDate || session.businessDate === state.historyDate;
    const matchesRoom = !state.historyRoomNo || session.roomNo === state.historyRoomNo;
    return matchesDate && matchesRoom;
  });
  const selectedSession = state.historySelectedSessionId ? state.sessions.find((session) => session.id === state.historySelectedSessionId) : null;
  const selectedRecords = selectedSession ? getSessionRecords(selectedSession.id) : [];
  const reportResult = selectedSession ? buildReportResult('session', [selectedSession]) : null;
  const selectedSummary = reportResult?.ok ? reportResult.model.summary : getCounts(selectedRecords);
  const reportText = reportResult ? reportPreviewText(reportResult) : '';
  const selectedRows = reportResult?.ok
    ? reportResult.model.rows.map((row) => `
        <div class="history-student-row">
          <span class="room-badge">${escapeHtml(row.className)}</span>
          <div class="history-student-name"><strong>${escapeHtml(row.studentName)}</strong><span>${escapeHtml(row.roomNo)} 寝</span></div>
          <span class="history-status status-${STATUS_META[row.status].tone}"><i data-lucide="${STATUS_META[row.status].icon}"></i>${STATUS_META[row.status].label}</span>
          ${row.remark ? `<span class="history-remark">${escapeHtml(row.remark)}</span>` : ''}
        </div>`).join('')
    : '';

  return `
    <section class="page-header"><div class="page-header-copy"><p class="section-kicker">ARCHIVE</p><h2>历史记录</h2><p>按日期和宿舍号查看本机保存的查寝结果。</p></div><span class="local-pill"><i data-lucide="database"></i>本地数据库</span></section>
    <section class="history-filters"><label class="field-label">日期<input type="date" id="history-date" value="${state.historyDate}" /></label><label class="field-label">宿舍号<select id="history-room"><option value="">全部宿舍</option>${rooms.map((room) => `<option value="${escapeHtml(room.roomNo)}"${room.roomNo === state.historyRoomNo ? ' selected' : ''}>${escapeHtml(room.roomNo)} 寝</option>`).join('')}</select></label><button class="secondary-button filter-reset" type="button" data-action="reset-history-filters"><i data-lucide="rotate-ccw"></i><span>清除</span></button></section>
    <section class="history-layout"><div class="history-list-panel"><div class="list-heading"><span>查寝批次</span><span>${filteredSessions.length} 条</span></div>${filteredSessions.length ? `<div class="history-list">${filteredSessions.map((session) => { const counts = getCounts(getSessionRecords(session.id)); return `<button class="history-card${session.id === state.historySelectedSessionId ? ' is-selected' : ''}" type="button" data-action="select-history" data-session-id="${session.id}"><div class="history-card-date"><strong>${formatDate(session.businessDate)}</strong><span>${session.status === 'completed' ? '已保存' : '草稿'}</span></div><h3>${escapeHtml(session.roomNo)} 寝</h3><div class="mini-counts"><span class="status-present">实到 ${counts.present}</span><span class="status-absent">未到 ${counts.absent}</span><span class="status-leave">请假 ${counts.leave}</span></div></button>`; }).join('')}</div>` : `<div class="empty-state"><div class="empty-icon"><i data-lucide="calendar-off"></i></div><h3>暂无历史记录</h3><p>完成第一次查寝后，记录会出现在这里。</p></div>`}</div>
      <div class="history-detail-panel">${selectedSession ? `<div class="detail-header"><div><p class="section-kicker">${formatDate(selectedSession.businessDate, true)}</p><h3>${escapeHtml(selectedSession.roomNo)} 寝</h3></div><button class="icon-button" type="button" data-action="edit-history" data-session-id="${selectedSession.id}" aria-label="编辑这次查寝" title="编辑这次查寝"><i data-lucide="pencil"></i></button></div><div class="detail-counts">${Object.entries({ present: selectedSummary.present, absent: selectedSummary.absent, leave: selectedSummary.leave }).map(([status, count]) => `<div class="detail-count ${STATUS_META[status].tone}"><strong>${count}</strong><span>${STATUS_META[status].label}</span></div>`).join('')}</div><div class="report-panel compact-report"><div class="detail-header"><div><p class="section-kicker">REPORT MODEL</p><h3>报告预览</h3></div>${renderReportActions()}</div><pre id="report-text">${escapeHtml(reportText)}</pre></div><div class="history-student-list">${selectedRows || '<div class="empty-state"><p>报告数据不完整，无法显示名单。</p></div>'}</div>` : `<div class="empty-state empty-state-detail"><div class="empty-icon"><i data-lucide="mouse-pointer-click"></i></div><h3>选择一条记录</h3><p>查看该次查寝的完整名单和生成文字。</p></div>`}</div>
    </section>
  `;
}
function renderManage() {
  const rooms = getRooms();
  const totalStudents = state.students.filter((student) => student.isActive !== false).length;
  const importPreview = state.importPreview;
  const backupPreview = state.backupPreview;
  const importRows = importPreview?.rows || [];
  const importIssues = importPreview?.issues || [];

  return `
    <section class="page-header">
      <div class="page-header-copy">
        <p class="section-kicker">ROSTER</p>
        <h2>名单管理</h2>
        <p>支持表格、文本和图片识别，确认后才写入本机名单。</p>
      </div>
      <span class="local-pill"><i data-lucide="shield-check"></i>不联网</span>
    </section>
    <section class="import-panel">
      <div class="import-panel-icon"><i data-lucide="file-up"></i></div>
      <div class="import-panel-copy">
        <h3>导入或识别宿舍名单</h3>
        <p>支持 Excel、CSV、TXT、Markdown、JSON 和 PNG/JPG 图片。必需信息为宿舍号、姓名，识别结果会先预览。${state.ocrProgress ? ` ${escapeHtml(state.ocrProgress)}` : ''}</p>
      </div>
      <div class="import-options">
        <label class="primary-button import-button">
          <i data-lucide="upload"></i><span>选择名单文件</span>
          <input type="file" id="excel-input" accept=".xlsx,.xls,.csv,.txt,.md,.markdown,.json,.png,.jpg,.jpeg,.webp" />
        </label>
        <label class="secondary-button import-button">
          <i data-lucide="scan-text"></i><span>图片识别</span>
          <input type="file" id="image-input" accept=".png,.jpg,.jpeg,.webp" />
        </label>
      </div>
    </section>
    ${
      importPreview
        ? `
      <section class="import-preview">
        <div class="import-preview-header">
          <div>
            <p class="section-kicker">IMPORT PREVIEW</p>
            <h3>待确认导入：${escapeHtml(importPreview.sourceName)}</h3>
          </div>
          <span class="local-pill">${importPreview.kind === 'image' ? '本地 OCR' : '结构化解析'}</span>
        </div>
        <div class="import-preview-stats">
          <span><strong>${importRows.length}</strong> 条有效记录</span>
          <span><strong>${importIssues.filter((issue) => issue.level === 'warning').length}</strong> 条提示</span>
          <span><strong>${importIssues.filter((issue) => issue.level === 'error').length}</strong> 条错误</span>
        </div>
        ${
          importPreview.recognizedText
            ? `<details class="import-text-preview"><summary>查看识别文本</summary><pre>${escapeHtml(importPreview.recognizedText.slice(0, 12000))}</pre></details>`
            : ''
        }
        ${
          importRows.length
            ? `<div class="import-table-wrap"><table class="import-table"><thead><tr><th>宿舍号</th><th>姓名</th><th>班级</th></tr></thead><tbody>${importRows
                .slice(0, 80)
                .map(
                  (row) =>
                    `<tr><td>${escapeHtml(row.roomNo)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.className)}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : `<div class="empty-state"><h3>没有可写入的记录</h3><p>请修正文件内容后重新选择。</p></div>`
        }
        ${
          importIssues.length
            ? `<div class="import-issues">${importIssues
                .slice(0, 20)
                .map((issue) => `<p class="import-issue import-issue-${issue.level}"><i data-lucide="${issue.level === 'error' ? 'circle-alert' : 'triangle-alert'}"></i>${escapeHtml(issue.message)}</p>`)
                .join('')}</div>`
            : ''
        }
        <div class="preview-actions">
          <button class="secondary-button" type="button" data-action="cancel-import"><i data-lucide="x"></i><span>取消</span></button>
          <button class="primary-button" type="button" data-action="confirm-import" ${importRows.length ? '' : 'disabled'}><i data-lucide="check"></i><span>确认导入 ${importRows.length} 条</span></button>
        </div>
      </section>
    `
        : ''
    }
    <section class="manage-toolbar">
      <div><p class="section-kicker">ROSTER OVERVIEW</p><div class="manage-summary"><strong>${rooms.length}</strong><span>个宿舍</span><strong>${totalStudents}</strong><span>名学生</span></div></div>
      <div class="manage-actions">
        <button class="secondary-button" type="button" data-action="add-student"><i data-lucide="user-plus"></i><span>添加学生</span></button>
        <button class="secondary-button" type="button" data-action="export-backup"><i data-lucide="download"></i><span>备份 JSON</span></button>
      </div>
    </section>
    <section class="export-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">EXPORT</p>
          <h3>导出名单与记录</h3>
        </div>
        <i data-lucide="package-open"></i>
      </div>
      <div class="export-actions">
        ${[
          ['xlsx', 'sheet', 'Excel'],
          ['csv', 'file-spreadsheet', 'CSV'],
          ['md', 'file-text', 'Markdown'],
          ['json', 'braces', 'JSON'],
        ]
          .map(
            ([format, icon, label]) =>
              `<button class="export-action" type="button" data-action="export-roster" data-format="${format}"><i data-lucide="${icon}"></i><span>${label}</span></button>`,
          )
          .join('')}
      </div>
    </section>
    <section class="archive-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">LOCAL ARCHIVE</p>
          <h3>存档目录</h3>
        </div>
        <i data-lucide="folder-cog"></i>
      </div>
      <p class="panel-copy">在支持目录写入的浏览器中，导出的文件会优先保存到你选择的目录；其他浏览器会自动下载。</p>
      <div class="archive-actions">
        <button class="secondary-button" type="button" data-action="choose-archive-directory"><i data-lucide="folder-open"></i><span>选择目录</span></button>
        <button class="text-button" type="button" data-action="clear-archive-directory" ${state.archiveDirectoryName ? '' : 'disabled'}><i data-lucide="folder-x"></i><span>清除目录</span></button>
        <span class="archive-name">${escapeHtml(state.archiveDirectoryName || '未设置，使用浏览器下载')}</span>
      </div>
    </section>
    ${renderUpdatePanel()}
    ${renderStoragePanel()}
    <section class="backup-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">RESTORE</p>
          <h3>恢复本地备份</h3>
        </div>
        <i data-lucide="history"></i>
      </div>
      <p class="panel-copy">选择此前导出的 JSON 备份，预览数量后再合并到当前设备。</p>
      <div class="backup-actions">
        <label class="secondary-button import-button">
          <i data-lucide="upload"></i><span>选择备份</span>
          <input type="file" id="backup-input" accept=".json,application/json" />
        </label>
        ${
          backupPreview
            ? `<span class="backup-preview">待恢复：${backupPreview.students} 名学生、${backupPreview.sessions} 条查寝、${backupPreview.records} 条明细
              <button class="text-button" type="button" data-action="confirm-restore"><i data-lucide="check"></i><span>确认恢复</span></button>
              <button class="text-button" type="button" data-action="cancel-restore"><i data-lucide="x"></i><span>取消</span></button>
            </span>`
            : ''
        }
      </div>
    </section>
    <section class="class-management-list">
      ${
        rooms.length
          ? rooms
              .map((room) => {
                const classes = [...new Set(room.students.map((student) => student.className).filter(Boolean))].sort(compareText);
                const commuterCount = room.students.filter((student) => student.isCommuter).length;
                return `
                  <article class="manage-class-card">
                    <div class="manage-class-main">
                      <div class="manage-class-symbol"><i data-lucide="door-open"></i></div>
                      <div><h3>${escapeHtml(room.roomNo)} 寝</h3><p>${room.students.length} 名学生${commuterCount ? ` · ${commuterCount} 名走读` : ''}${classes.length ? ` · ${escapeHtml(classes.join('、'))}` : ''}</p></div>
                    </div>
                    <div class="manage-class-actions">
                      <button class="text-button" type="button" data-action="open-attendance" data-room-no="${escapeHtml(room.roomNo)}"><i data-lucide="clipboard-check"></i><span>点名</span></button>
                      <button class="text-button danger-text" type="button" data-action="delete-room" data-room-no="${escapeHtml(room.roomNo)}"><i data-lucide="trash-2"></i><span>删除</span></button>
                      <button class="text-button" type="button" data-action="open-commuter" data-room-no="${escapeHtml(room.roomNo)}"><i data-lucide="house"></i><span>走读</span></button>
                    </div>
                  </article>
                `;
              })
              .join('')
          : `<div class="empty-state"><div class="empty-icon"><i data-lucide="folder-open"></i></div><h3>还没有名单</h3><p>选择名单文件或图片开始导入。</p></div>`
      }
    </section>
    <section class="data-notice">
      <i data-lucide="info"></i>
      <p>这是本地应用：数据只存在当前浏览器和设备中。导入、识别、导出和备份均在本机完成，不上传名单。</p>
    </section>
  `;
}

function renderUpdatePanel() {
  const nativeAppInfo = getNativeAppInfo();
  const updateEnabled = supportsNativeUpdate();
  const updateStatus = state.updateStatus || { state: 'idle', message: '' };
  if (!updateEnabled) {
    return '<section class="update-panel"><div class="panel-heading"><div><p class="section-kicker">APP UPDATE</p><h3>应用更新</h3></div><i data-lucide="refresh-cw"></i></div><p class="panel-copy">当前为浏览器版本，应用内更新仅在 Android 安装包中可用。</p></section>';
  }

  const installButton = updateStatus.state === 'ready'
    ? '<button class="primary-button" type="button" data-action="install-app-update"><i data-lucide="download"></i><span>安装更新</span></button>'
    : '';
  const checkDisabled = state.isBusy ? 'disabled' : '';
  return [
    '<section class="update-panel">',
    '<div class="panel-heading"><div><p class="section-kicker">APP UPDATE</p><h3>应用更新</h3></div><i data-lucide="refresh-cw"></i></div>',
    '<p class="panel-copy">当前版本 ' + escapeHtml(nativeAppInfo.versionName) + '。点击检查更新后，应用会从内置的官方更新源检查、验证并下载新版 APK。</p>',
    '<div class="update-actions">',
    '<button class="primary-button" type="button" data-action="check-app-update" ' + checkDisabled + '><i data-lucide="search-check"></i><span>检查更新</span></button>',
    installButton,
    '</div>',
    '<p class="update-status update-status-' + escapeHtml(updateStatus.state) + '">' + escapeHtml(updateStatus.message || '尚未检查更新') + '</p>',
    '</section>',
  ].join('');
}

function renderStoragePanel() {
  // 仅在 iOS 或支持 Storage API 的环境中显示
  if (!state.iosStandaloneMode) {
    return '';
  }

  const usagePercent = state.storageEstimate.quota > 0
    ? Math.round((state.storageEstimate.usage / state.storageEstimate.quota) * 100)
    : 0;

  const lastBackupTime = state.lastBackupTime
    ? formatDate(state.lastBackupTime.toISOString().split('T')[0])
    : '从未备份';

  const ocrCacheDate = state.ocrCacheVersion
    ? formatDate(new Date(state.ocrCacheVersion).toISOString().split('T')[0])
    : '未准备';

  return `
    <section class="storage-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">DATA PROTECTION</p>
          <h3>数据保护</h3>
        </div>
        <i data-lucide="lock"></i>
      </div>
      <p class="panel-copy">管理本地存储空间，保护离线数据。本应用不使用云同步，所有数据仅存在本设备中。</p>
      <div class="storage-info">
        <div class="storage-item">
          <div class="storage-label">本地存储空间</div>
          <div class="storage-detail">
            <div class="storage-bar">
              <div class="storage-used" style="width: ${usagePercent}%"></div>
            </div>
            <p class="storage-text">${usagePercent}% 已用 (${formatBytes(state.storageEstimate.usage)} / ${formatBytes(state.storageEstimate.quota)})</p>
          </div>
        </div>
        <div class="storage-item">
          <div class="storage-label">最后备份</div>
          <div class="storage-detail">${escapeHtml(lastBackupTime)}</div>
        </div>
        ${state.persistentStorageGranted ? `
        <div class="storage-item">
          <div class="storage-label">持久化存储</div>
          <div class="storage-detail">已启用 <i data-lucide="check-circle" class="check-icon"></i></div>
        </div>
        ` : `
        <div class="storage-item">
          <div class="storage-label">持久化存储</div>
          <div class="storage-detail">
            <p class="storage-text">启用持久化存储后，即使清理浏览器缓存，应用数据也会保留。</p>
            <button class="primary-button" type="button" data-action="request-persistent-storage">
              <i data-lucide="unlock"></i><span>启用持久化存储</span>
            </button>
          </div>
        </div>
        `}
        ${state.ocrOfflineReady ? `
        <div class="storage-item">
          <div class="storage-label">离线 OCR 资源</div>
          <div class="storage-detail">已准备 (${escapeHtml(ocrCacheDate)}) <i data-lucide="check-circle" class="check-icon"></i></div>
        </div>
        ` : `
        <div class="storage-item">
          <div class="storage-label">离线 OCR 资源</div>
          <div class="storage-detail">
            <p class="storage-text">下载 OCR 语言模型和运行时文件后，可离线识别图片中的学生信息。需要网络和足够存储空间。</p>
            ${state.ocrProgress ? `<p class="ocr-progress">${escapeHtml(state.ocrProgress)}</p>` : ''}
            <button class="primary-button" type="button" data-action="prepare-offline-ocr" ${state.ocrProgress ? 'disabled' : ''}>
              <i data-lucide="download"></i><span>${state.ocrProgress ? '准备中...' : '准备离线 OCR'}</span>
            </button>
          </div>
        </div>
        `}
      </div>
    </section>
  `;
}


function renderCommuterManage() {
  const roomNo = normalizeRoomNo(state.commuterRoomNo);
  const students = getRoomStudents(roomNo, false);
  const commuterCount = students.filter((student) => student.isCommuter).length;

  return `
    <section class="page-header commuter-header">
      <button class="back-button" type="button" data-action="navigate" data-route="manage" title="返回名单"><i data-lucide="arrow-left"></i></button>
      <div class="page-header-copy">
        <p class="section-kicker">COMMUTER ROSTER</p>
        <h2>${escapeHtml(roomNo)} 寝走读名单</h2>
        <p>${students.length} 名学生 · 已标记 ${commuterCount} 名走读</p>
      </div>
      <span class="local-pill"><i data-lucide="house"></i>本机名单</span>
    </section>
    <section class="commuter-list-section">
      <div class="list-heading"><span>学生姓名</span><span>走读标记</span></div>
      <div class="commuter-list">
        ${
          students.length
            ? students
                .map(
                  (student) => `
                    <article class="commuter-student-row${student.isCommuter ? ' is-commuter' : ''}">
                      <div class="student-identity">
                        <span class="room-badge">${escapeHtml(student.className || '未分班')}</span>
                        <div><h3>${escapeHtml(student.name)}</h3><p>${escapeHtml(student.roomNo)} 寝</p></div>
                      </div>
                      <button class="commuter-toggle${student.isCommuter ? ' is-active' : ''}" type="button" data-action="toggle-commuter" data-student-id="${student.id}" aria-pressed="${student.isCommuter ? 'true' : 'false'}">
                        <i data-lucide="${student.isCommuter ? 'check' : 'plus'}"></i><span>${student.isCommuter ? '走读' : '标记走读'}</span>
                      </button>
                    </article>`,
                )
                .join('')
            : `<div class="empty-state"><div class="empty-icon"><i data-lucide="users-round"></i></div><h3>没有可标记的学生</h3></div>`
        }
      </div>
    </section>
  `;
}

function render() {
  normalizeViewState();
  let content = '';
  if (state.route === 'attendance') content = renderAttendance();
  else if (state.route === 'room-select') content = renderRoomSelect();
  else if (state.route === 'export') content = renderExport();
  else if (state.route === 'history') content = renderHistory();
  else if (state.route === 'manage') content = renderManage();
  else if (state.route === 'commuter') content = renderCommuterManage();
  else content = renderHome();
  app.innerHTML = renderShell(content);
  createIcons({ icons });
}

function showToast(message, type = 'info') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  clearTimeout(state.toastTimer);
  root.innerHTML = `<div class="toast toast-${type}"><i data-lucide="${type === 'error' ? 'alert-circle' : type === 'success' ? 'check-circle-2' : 'info'}"></i><span>${escapeHtml(message)}</span></div>`;
  createIcons({ icons });
  state.toastTimer = setTimeout(() => {
    root.innerHTML = '';
  }, 2800);
}

function setBusy(value) {
  state.isBusy = value;
  document.body.classList.toggle('is-busy', value);
}

function createRecordFromStudent(student, sessionId = null) {
  return {
    id: uid('record'),
    sessionId,
    studentId: student.id,
    studentNameSnapshot: student.name,
    classNameSnapshot: student.className || '',
    roomNoSnapshot: student.roomNo || '',
    status: 'present',
    remark: '',
    updatedAt: new Date().toISOString(),
  };
}

function createDraft(roomNo, date) {
  const students = getRoomStudents(roomNo);
  const existing = getSession(roomNo, date);
  const records = existing
    ? getSessionRecords(existing.id).map((record) => ({ ...record }))
    : students.map((student) => createRecordFromStudent(student, existing?.id || null));

  return {
    id: existing?.id || uid('session'),
    roomNo: normalizeRoomNo(roomNo),
    businessDate: date,
    checkerName: existing?.checkerName || state.checkerName || '',
    status: existing?.status || 'draft',
    records,
  };
}

function ensureDraftRecord(studentId) {
  if (!state.attendanceDraft) return null;
  let record = state.attendanceDraft.records.find((item) => item.studentId === studentId);
  if (!record) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return null;
    record = createRecordFromStudent(student, state.attendanceDraft.id);
    state.attendanceDraft.records.push(record);
  }
  return record;
}

function openAttendance(roomNo, date = state.attendanceDate) {
  const selectedRoomNo = normalizeRoomNo(roomNo);
  if (!getRoomStudents(selectedRoomNo).length) {
    state.route = state.checkMode ? 'room-select' : 'home';
    render();
    showToast('该宿舍没有可点名的学生', 'error');
    return;
  }
  state.selectedRoomNo = selectedRoomNo;
  state.attendanceDate = isValidBusinessDate(date) ? date : todayString();
  state.attendanceDraft = createDraft(state.selectedRoomNo, state.attendanceDate);
  state.attendanceSearch = '';
  state.attendanceFilter = 'all';
  state.route = 'attendance';
  render();
}

function openCommuterManage(roomNo) {
  const selectedRoomNo = normalizeRoomNo(roomNo);
  if (!getRoomStudents(selectedRoomNo).length) {
    state.route = 'manage';
    render();
    showToast('该宿舍没有可标记的学生', 'error');
    return;
  }
  state.commuterRoomNo = selectedRoomNo;
  state.route = 'commuter';
  render();
}

async function toggleCommuter(studentId) {
  const student = state.students.find((item) => item.id === studentId);
  if (!student || state.isBusy) return;
  setBusy(true);
  try {
    const next = {
      ...student,
      isCommuter: !student.isCommuter,
      updatedAt: new Date().toISOString(),
    };
    await dbPut(STORES.students, next);
    await refreshData();
    render();
    showToast(next.isCommuter ? `已标记${next.name}为走读` : `已取消${next.name}的走读标记`, 'success');
  } catch (error) {
    console.error(error);
    showToast('走读标记保存失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function saveAttendance({ navigateAfter = false } = {}) {
  if (!state.attendanceDraft || state.isBusy) return null;
  setBusy(true);
  state.updateGuard.isSaving = true;
  try {
    const now = new Date().toISOString();
    const roomStudents = getRoomStudents(state.attendanceDraft.roomNo);
    const recordsByStudent = new Map(state.attendanceDraft.records.map((record) => [record.studentId, record]));
    const completeRecords = roomStudents.map((student) => recordsByStudent.get(student.id) || createRecordFromStudent(student, state.attendanceDraft.id));
    const draft = {
      ...state.attendanceDraft,
      records: completeRecords,
      checkerName: state.checkerName || state.attendanceDraft.checkerName || '',
      status: 'completed',
      updatedAt: now,
      completedAt: now,
    };

    await dbPutMany(STORES.sessions, [draft]);
    await dbReplaceSessionRecords(
      draft.id,
      draft.records.map((record) => ({
        ...record,
        sessionId: draft.id,
        updatedAt: now,
      })),
    );

    await refreshData();
    state.attendanceDraft = draft;
    if (state.checkMode && !state.checkMode.sessionIds.includes(draft.id)) {
      state.checkMode.sessionIds.push(draft.id);
    }

    // 记录有意义的活动（带节流）
    await recordMeaningfulActivity();

    if (navigateAfter && state.checkMode) {
      const nextRoom = getNextCheckRoom(draft.roomNo);
      if (nextRoom) {
        openAttendance(nextRoom.roomNo, state.checkMode?.date || state.attendanceDate);
      } else {
        state.route = 'room-select';
        render();
      }
    } else {
      render();
    }
    showToast('当前寝室已保存', 'success');
    return draft;
  } catch (error) {
    console.error(error);
    // 检查是否是存储配额错误
    if (error.name === 'QuotaExceededError') {
      showToast('存储空间不足，请导出备份后清理数据', 'error');
    } else {
      showToast('保存失败，请重试', 'error');
    }
    return null;
  } finally {
    state.updateGuard.isSaving = false;
    setBusy(false);
  }
}

function getNextCheckRoom(currentRoomNo) {
  const rooms = getRooms();
  const currentIndex = rooms.findIndex((room) => room.roomNo === normalizeRoomNo(currentRoomNo));
  const completed = new Set(state.checkMode?.sessionIds || []);
  const date = state.checkMode?.date || state.attendanceDate;
  return rooms.slice(Math.max(currentIndex + 1, 0)).find((room) => {
    const session = getSession(room.roomNo, date);
    return !completed.has(session?.id) && session?.status !== 'completed';
  }) || rooms.find((room) => {
    const session = getSession(room.roomNo, date);
    return !completed.has(session?.id) && session?.status !== 'completed';
  });
}

function startCheckMode() {
  state.startDialogOpen = true;
  state.startDialogError = '';
  render();
  requestAnimationFrame(() => document.querySelector('#start-checker-name')?.focus());
}

async function confirmStartCheck() {
  if (state.isBusy) return;
  const name = document.querySelector('#start-checker-name')?.value?.trim() || '';
  if (!name) {
    state.startDialogError = '请输入查寝人姓名';
    render();
    return;
  }
  setBusy(true);
  try {
    await dbPut(STORES.settings, { key: 'checkerName', value: name });
    state.checkerName = name;
    state.startDialogOpen = false;
    state.startDialogError = '';
    state.checkMode = { date: state.attendanceDate, checkerName: name, sessionIds: [] };
    state.route = 'room-select';
    render();
  } catch (error) {
    console.error(error);
    state.startDialogError = '查寝人姓名保存失败，请重试';
    render();
  } finally {
    setBusy(false);
  }
}

function cancelStartCheck() {
  state.startDialogOpen = false;
  state.startDialogError = '';
  render();
}

function endCheckMode() {
  if (!state.checkMode) return;
  if (!getCheckModeSessions().length) {
    state.route = 'room-select';
    render();
    showToast('请至少保存一个寝室后再结束查寝', 'error');
    return;
  }
  state.route = 'export';
  render();
}

function finishCheckMode() {
  state.checkMode = null;
  state.attendanceDraft = null;
  state.selectedRoomNo = '';
  state.route = 'home';
  render();
}

function markAllPresent() {
  if (!state.attendanceDraft) return;
  state.attendanceDraft.records = getRoomStudents(state.selectedRoomNo).map((student) => {
    const current = ensureDraftRecord(student.id);
    return { ...current, status: 'present', remark: '', updatedAt: new Date().toISOString() };
  });
  render();
  showToast('已将当前宿舍全部标记为到');
}

async function saveCheckerName() {
  const input = document.querySelector('#checker-name');
  const value = input?.value?.trim() || '';
  await dbPut(STORES.settings, { key: 'checkerName', value });
  state.checkerName = value;
  render();
  showToast('查寝人名称已保存', 'success');
}

function getFileExtension(file) {
  return String(file?.name || '').split('.').pop()?.toLowerCase() || '';
}

function isSupportedImportFile(file) {
  return /\.(xlsx|xls|csv|txt|md|markdown|json|png|jpg|jpeg|webp)$/i.test(file?.name || '');
}

function createImportResult(result, sourceName, kind) {
  return {
    ...result,
    sourceName,
    kind,
    rows: result.rows.slice(0, MAX_IMPORT_ROWS),
  };
}

async function recognizeImage(file) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import('tesseract.js').then(({ createWorker }) =>
      createWorker('chi_sim+eng', 1, {
        workerPath: resolveLocalAssetUrl(OCR_ASSET_PATHS.worker),
        corePath: resolveLocalAssetUrl(OCR_ASSET_PATHS.core),
        langPath: resolveLocalAssetUrl(OCR_ASSET_PATHS.lang),
        workerBlobURL: false,
        cacheMethod: 'write',
        logger: (message) => {
          if (message.status === 'recognizing text' && typeof message.progress === 'number') {
            state.ocrProgress = `图片识别中 ${Math.round(message.progress * 100)}%`;
            render();
          }
        },
      }),
    );
  }

  const worker = await ocrWorkerPromise;
  const result = await worker.recognize(file);
  state.ocrProgress = '';
  return result.data?.text || '';
}

async function parseImportFile(file) {
  if (!file) return null;
  if (!isSupportedImportFile(file)) {
    throw new Error('不支持的文件格式，请选择表格、文本、JSON 或图片文件');
  }

  const extension = getFileExtension(file);
  const limit = ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > limit) throw new Error(`文件过大，当前上限为 ${Math.round(limit / 1024 / 1024)} MB`);

  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    const text = await recognizeImage(file);
    if (!text.trim()) throw new Error('图片中没有识别到文字');
    return createImportResult(parseTextRecords(text, file.name), file.name, 'image');
  }

  if (extension === 'json') {
    const text = await file.text();
    return createImportResult(parseJsonRecords(text, file.name), file.name, 'json');
  }

  if (['txt', 'md', 'markdown', 'csv'].includes(extension)) {
    const text = await file.text();
    if (text.length > MAX_TEXT_LENGTH) throw new Error('文本内容过长，已超过本地解析上限');
    return createImportResult(parseTextRecords(text, file.name), file.name, 'text');
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const rows = [];
  const issues = [];
  let recognizedText = '';
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!matrix.length) return;
    const result = normalizeImportRows(matrix, `${file.name} / ${sheetName}`);
    rows.push(...result.rows);
    issues.push(...result.issues);
    recognizedText += `${sheetName}\n${result.recognizedText}\n`;
  });

  const dedupedRows = [];
  const seen = new Set();
  rows.forEach((row) => {
    const key = importRowKey(row);
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRows.push(row);
    } else {
      issues.push({ row: 0, level: 'warning', message: `发现重复学生记录：${row.roomNo} / ${row.name}，已去重` });
    }
  });

  return createImportResult(
    { rows: dedupedRows, issues, recognizedText: recognizedText.slice(0, 12000) },
    file.name,
    'spreadsheet',
  );
}

async function prepareImportFile(file) {
  if (!file || state.isBusy) return;
  setBusy(true);
  state.ocrProgress = '';
  try {
    state.importPreview = await parseImportFile(file);
    state.route = 'manage';
    render();
    showToast(`已解析 ${state.importPreview.rows.length} 条记录，请确认后导入`, 'success');
  } catch (error) {
    console.error(error);
    state.ocrProgress = '';
    showToast(error.message || '名单解析失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function commitImportPreview() {
  const preview = state.importPreview;
  if (!preview?.rows?.length || state.isBusy) return;
  setBusy(true);
  state.updateGuard.isImporting = true;
  try {
    const currentStudents = [...state.students];
    const existingByKey = new Map(currentStudents.map((student) => [
      importRowKey({
        roomNo: student.roomNo,
        name: student.name,
        className: student.className,
      }),
      student,
    ]));
    const now = new Date().toISOString();
    const writes = [];
    let added = 0;
    let updated = 0;

    preview.rows.forEach((row) => {
      const key = importRowKey(row);
      const duplicate = existingByKey.get(key);
      const next = duplicate
        ? {
            ...duplicate,
            roomNo: normalizeRoomNo(row.roomNo),
            name: sanitizeImportedValue(row.name),
        className: normalizeClassName(row.className),
            isActive: true,
            updatedAt: now,
          }
        : {
            id: uid('student'),
            roomNo: normalizeRoomNo(row.roomNo),
            name: sanitizeImportedValue(row.name),
            className: normalizeClassName(row.className),
            isActive: true,
            isCommuter: false,
            createdAt: now,
            updatedAt: now,
          };
      writes.push(next);
      existingByKey.set(key, next);
      if (duplicate) updated += 1;
      else added += 1;
    });

    await dbPutMany(STORES.students, writes);
    state.importPreview = null;
    await refreshData();

    // 记录有意义的活动
    await recordMeaningfulActivity();

    render();
    showToast(`导入完成，新增 ${added} 人，更新 ${updated} 人`, 'success');
  } catch (error) {
    console.error(error);
    if (error.name === 'QuotaExceededError') {
      showToast('存储空间不足，导入失败', 'error');
    } else {
      showToast('导入写入失败，本次没有完成导入', 'error');
    }
  } finally {
    state.updateGuard.isImporting = false;
    setBusy(false);
  }
}

function addStudent() {
  const roomNo = normalizeRoomNo(window.prompt('宿舍号：', state.selectedRoomNo || ''));
  if (!roomNo) return;
  const name = window.prompt('姓名：', '')?.trim();
  if (!name) {
    showToast('姓名不能为空', 'error');
    return;
  }
  const className = normalizeClassName(window.prompt('班级：', ''));
  dbPut(STORES.students, {
    id: uid('student'),
    roomNo,
    name,
    className,
    isActive: true,
    isCommuter: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
    .then(refreshData)
    .then(() => {
      render();
      showToast('学生已添加', 'success');
    })
    .catch(() => showToast('添加失败', 'error'));
}

async function deleteRoom(roomNo) {
  const students = getRoomStudents(roomNo, false);
  const sessions = state.sessions.filter((session) => session.roomNo === roomNo);
  if (!window.confirm(`确定删除“${roomNo}寝”吗？\n相关学生和查寝记录也会从本机删除。`)) return;
  setBusy(true);
  try {
    for (const student of students) await dbDelete(STORES.students, student.id);
    for (const session of sessions) {
      await dbDelete(STORES.sessions, session.id);
      for (const record of getSessionRecords(session.id)) await dbDelete(STORES.records, record.id);
    }
    await refreshData();
    render();
    showToast('宿舍及其本地记录已删除', 'success');
  } catch {
    showToast('删除失败', 'error');
  } finally {
    setBusy(false);
  }
}

function safeFileName(value, fallback = '喵喵查寝文件') {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 90)
    .trim() || fallback;
}


function rosterRows() {
  return state.students
    .filter((student) => student.isActive !== false)
    .map((student) => ({
      宿舍号: safeSpreadsheetCell(student.roomNo),
      姓名: safeSpreadsheetCell(student.name),
      班级: safeSpreadsheetCell(student.className || ''),
    }));
}

function toCsv(rows) {
  if (!rows.length) return '\uFEFF';
  const headers = Object.keys(rows[0]);
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return `\uFEFF${[headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(quote).join(','))
    .join('\r\n')}`;
}

function toMarkdownTable(rows) {
  if (!rows.length) return '# 喵喵查寝名单\n\n暂无学生记录\n';
  const headers = Object.keys(rows[0]);
  return [
    '# 喵喵查寝名单',
    '',
    `导出日期：${todayString()}`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => String(row[header] ?? '').replaceAll('|', '\\|')).join(' | ')} |`),
    '',
  ].join('\n');
}

async function saveBlob(blob, filename) {
  if (window.AndroidFileBridge?.saveFile) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
        reader.readAsDataURL(blob);
      });
      const saved = window.AndroidFileBridge.saveFile(
        filename,
        blob.type || 'application/octet-stream',
        dataUrl,
      );
      if (saved === 'saved') {
        showToast('已保存到手机“下载/喵喵查寝”文件夹', 'success');
        return true;
      }
    } catch (error) {
      console.warn('android native save failed, fallback to browser download', error);
    }
  }

  const directory = state.archiveDirectoryHandle;
  if (directory?.getFileHandle) {
    try {
      const permission = await directory.queryPermission?.({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const requested = await directory.requestPermission?.({ mode: 'readwrite' });
        if (requested !== 'granted') throw new Error('没有目录写入权限');
      }
      const fileHandle = await directory.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast(`已保存到${state.archiveDirectoryName ? `“${state.archiveDirectoryName}”` : '存档目录'}`, 'success');
      return true;
    } catch (error) {
      console.warn('archive directory save failed, fallback to browser download', error);
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return false;
}

function dismissBackupReminder() {
  // 设置提醒关闭时间为 7 天后
  const sevenDaysLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  state.backupReminderDismissedUntil = sevenDaysLater.toISOString();
  dbPut(STORES.settings, { key: 'backupReminderDismissedUntil', value: sevenDaysLater.toISOString() })
    .catch((error) => console.warn('[Backup Reminder] Failed to save dismissal timestamp:', error));
  render();
  showToast('7 天内不再提醒', 'success');
}

async function requestPersistentStorageUser() {
  try {
    const persistent = await requestPersistentStorage();
    if (persistent) {
      state.persistentStorageGranted = true;
      render();
      showToast('持久化存储已启用，你的数据现在受到更好的保护', 'success');
    } else {
      showToast('系统拒绝了持久化存储请求，可能空间不足或设置限制', 'warning');
    }
  } catch (error) {
    console.error('[Storage] Failed to request persistent:', error);
    showToast('无法请求持久化存储，请检查浏览器设置', 'error');
  }
}

async function prepareOfflineOcrUser() {
  const result = await prepareOfflineOcr();
  if (result.success) {
    showToast(result.message, 'success');
  } else {
    showToast(result.message, 'error');
  }
}


/**
 * OCR 离线缓存清单：记录需要缓存的文件及其预期路径（版本化到 v1）
 */
const OCR_CACHE_MANIFEST = [
  {
    name: 'Tesseract.js Worker',
    path: OCR_ASSET_PATHS.worker,
    required: true,
  },
  {
    name: 'Tesseract.js WASM Core',
    path: OCR_ASSET_PATHS.coreFile,
    required: true,
  },
  {
    name: '中文语言模型',
    path: OCR_ASSET_PATHS.chiLang,
    required: true,
  },
  {
    name: '英文语言模型',
    path: OCR_ASSET_PATHS.engLang,
    required: false,  // 可选但建议下载
  },
];

/**
 * 检查 OCR 缓存的完整性
 * @returns {Promise<{ready: boolean, missing: Array<string>}>}
 */
async function checkOcrCacheIntegrity() {
  const missing = [];

  try {
    const cache = await caches.open('catcheck-ocr-v1').catch(() => null);
    if (!cache) {
      return { ready: false, missing: OCR_CACHE_MANIFEST.filter(m => m.required).map(m => m.name) };
    }

    for (const item of OCR_CACHE_MANIFEST) {
      if (item.required) {
        const response = await cache.match(resolveLocalAssetUrl(item.path)).catch(() => null);
        if (!response) {
          missing.push(item.name);
        }
      }
    }

    return {
      ready: missing.length === 0,
      missing,
    };
  } catch (error) {
    console.error('[OCR] Failed to check cache integrity:', error);
    return { ready: false, missing: ['缓存检查失败'] };
  }
}

/**
 * 准备离线 OCR：下载所有必需的 OCR 资源到 Service Worker 缓存
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function prepareOfflineOcr() {
  // 检查网络状态
  if (!navigator.onLine) {
    return { success: false, message: '设备离线，无法下载 OCR 资源' };
  }

  // 检查存储配额
  const estimate = await updateStorageEstimate();
  const requiredSpace = 200 * 1024 * 1024; // 约 200 MiB
  const availableSpace = estimate.quota - estimate.usage;
  if (availableSpace < requiredSpace) {
    return {
      success: false,
      message: `存储空间不足，需要 ${formatBytes(requiredSpace)}，可用 ${formatBytes(availableSpace)}`
    };
  }

  try {
    state.ocrProgress = '正在打开缓存...';
    render();
    const cache = await caches.open('catcheck-ocr-v1');

    let successCount = 0;
    const requiredItems = OCR_CACHE_MANIFEST.filter(item => item.required);

    for (let i = 0; i < OCR_CACHE_MANIFEST.length; i++) {
      const item = OCR_CACHE_MANIFEST[i];
      const fullUrl = resolveLocalAssetUrl(item.path);

      try {
        state.ocrProgress = `正在下载 ${item.name}... (${i + 1}/${OCR_CACHE_MANIFEST.length})`;
        render();

        const response = await fetch(fullUrl);
        if (!response.ok) {
          if (item.required) {
            console.error(`[OCR] Failed to fetch required ${item.name}:`, response.status);
            state.ocrProgress = '';
            render();
            return { success: false, message: `无法下载 ${item.name}` };
          } else {
            console.warn(`[OCR] Failed to fetch optional ${item.name}:`, response.status);
            continue;
          }
        }

        await cache.put(fullUrl, response.clone());
        successCount++;
      } catch (error) {
        if (item.required) {
          console.error(`[OCR] Exception while fetching ${item.name}:`, error);
          state.ocrProgress = '';
          render();
          return { success: false, message: `下载失败: ${item.name}` };
        } else {
          console.warn(`[OCR] Exception while fetching optional ${item.name}:`, error);
        }
      }
    }

    // 验证完整性
    const integrity = await checkOcrCacheIntegrity();
    if (!integrity.ready) {
      state.ocrProgress = '';
      render();
      return { success: false, message: `缓存验证失败，缺少: ${integrity.missing.join(', ')}` };
    }

    // 保存 OCR 缓存版本
    const cacheVersion = new Date().toISOString();
    await dbPut(STORES.settings, { key: 'ocrCacheVersion', value: cacheVersion });
    state.ocrCacheVersion = cacheVersion;
    state.ocrOfflineReady = true;

    state.ocrProgress = '';
    render();
    return { success: true, message: `成功准备离线 OCR，共下载 ${successCount} 项资源` };
  } catch (error) {
    console.error('[OCR] Failed to prepare offline:', error);
    state.ocrProgress = '';
    render();
    return { success: false, message: `准备失败: ${error.message}` };
  }
}

async function exportBackup() {
  // 先构造备份数据（version 3 格式）
  const payload = {
    checkerName: state.checkerName,
    students: state.students.map((student) => ({
      id: student.id,
      roomNo: student.roomNo,
      name: student.name,
      className: student.className,
      isActive: student.isActive !== false,
      isCommuter: student.isCommuter === true,
      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
    })),
    sessions: state.sessions,
    records: state.records,
  };

  // 计算 payload 的 SHA-256 哈希
  const payloadJson = JSON.stringify(payload);
  const payloadSha256 = await sha256(payloadJson);

  // 构造完整的备份格式 version 3
  const backup = {
    format: 'dorm-check-local-backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    payload,
    integrity: {
      algorithm: 'SHA-256',
      payloadSha256,
    },
  };

  // 更新最后备份时间
  try {
    await dbPut(STORES.settings, { key: 'lastBackupTime', value: backup.exportedAt });
    state.lastBackupTime = new Date(backup.exportedAt);
  } catch (error) {
    console.warn('[Backup] Failed to update lastBackupTime:', error);
  }

  saveBlob(
    new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }),
    `喵喵查寝备份_${todayString()}.json`,
  ).then((savedToDirectory) => {
    if (!savedToDirectory) showToast('本地备份已导出', 'success');
  });
}

async function exportRoster(format) {
  const rows = rosterRows();
  const stamp = todayString();
  let blob;
  let filename;

  if (format === 'xlsx') {
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '学生名单');
    blob = new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    filename = `喵喵查寝名单_${stamp}.xlsx`;
  } else if (format === 'csv') {
    blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    filename = `喵喵查寝名单_${stamp}.csv`;
  } else if (format === 'md') {
    blob = new Blob([toMarkdownTable(rows)], { type: 'text/markdown;charset=utf-8' });
    filename = `喵喵查寝名单_${stamp}.md`;
  } else {
    blob = new Blob(
      [JSON.stringify({ format: 'dorm-check-roster', exportedAt: new Date().toISOString(), students: state.students }, null, 2)],
      { type: 'application/json;charset=utf-8' },
    );
    filename = `喵喵查寝名单_${stamp}.json`;
  }

  const savedToDirectory = await saveBlob(blob, filename);
  if (!savedToDirectory) showToast(`已导出名单 ${format.toUpperCase()}`, 'success');
}

function reportExportStamp() {
  const date = new Date();
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}_${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function formatReportDiagnostic(diagnostic) {
  const location = [diagnostic.sessionId, diagnostic.studentId].filter(Boolean).join(' / ');
  return `${diagnostic.code}${location ? `（${location}）` : ''}：${diagnostic.message}`;
}

function openReportErrorDialog(errors, descriptor) {
  state.reportDialog = { kind: 'error', errors, descriptor };
  render();
}

function openReportWarningDialog(result, descriptor) {
  state.reportDialog = {
    kind: 'warning',
    diagnostics: result.warnings,
    fingerprint: createReportConfirmationFingerprint(result),
    descriptor,
    showDetails: false,
  };
  render();
}

function warningGroups(diagnostics) {
  const groups = new Map();
  diagnostics.forEach((warning) => {
    const key = [warning.code, warning.sessionId || '', warning.details?.resolution || ''].join('|');
    const current = groups.get(key) || { ...warning, count: 0, studentIds: [] };
    current.count += 1;
    if (warning.studentId) current.studentIds.push(warning.studentId);
    groups.set(key, current);
  });
  return [...groups.values()];
}

function renderReportDialog() {
  const dialog = state.reportDialog;
  if (!dialog) return '';
  if (dialog.kind === 'error') {
    const identifier = dialog.errors.map((item) => item.code).join(', ');
    return `
      <div class="modal-scrim" role="presentation">
        <section class="md-dialog report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-error-title">
          <div class="dialog-icon dialog-icon-error"><i data-lucide="triangle-alert"></i></div>
          <h2 id="report-error-title">报告暂不可导出</h2>
          <p>数据未通过一致性校验，因此没有生成文件。请先修正或恢复记录。</p>
          <ul class="report-diagnostic-list">${dialog.errors.map((error) => `<li><code>${escapeHtml(error.code)}</code><span>${escapeHtml(error.message)}</span></li>`).join('')}</ul>
          <div class="dialog-actions report-dialog-actions">
            <button class="secondary-button" type="button" data-action="report-error-back"><i data-lucide="arrow-left"></i><span>返回查寝记录</span></button>
            <button class="secondary-button" type="button" data-action="report-error-backup"><i data-lucide="database-backup"></i><span>备份与恢复</span></button>
            <button class="text-button" type="button" data-action="report-error-copy" data-diagnostic-id="${escapeHtml(identifier)}">复制诊断编号</button>
          </div>
        </section>
      </div>`;
  }
  if (dialog.kind === 'warning') {
    const groups = warningGroups(dialog.diagnostics);
    return `
      <div class="modal-scrim" role="presentation">
        <section class="md-dialog report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-warning-title">
          <div class="dialog-icon dialog-icon-warning"><i data-lucide="triangle-alert"></i></div>
          <h2 id="report-warning-title">发现重复查寝记录</h2>
          <p>系统已按“最新修改时间优先、时间相同则保留最后一条”生成报告。继续前请确认。</p>
          <ul class="report-diagnostic-list">${groups.map((warning) => `<li><code>${escapeHtml(warning.code)}</code><span>${escapeHtml(`${warning.count} 组记录已采用 ${warning.details?.resolution === 'latest-updated-at' ? '最新修改' : '最后输入'}的内容`)}</span></li>`).join('')}</ul>
          ${dialog.showDetails ? `<details class="report-diagnostic-details" open><summary>重复记录详情</summary><pre>${escapeHtml(dialog.diagnostics.map(formatReportDiagnostic).join('\n'))}</pre></details>` : ''}
          <div class="dialog-actions report-dialog-actions">
            <button class="text-button" type="button" data-action="report-warning-cancel">取消</button>
            <button class="secondary-button" type="button" data-action="report-warning-details"><i data-lucide="list-tree"></i><span>查看详情</span></button>
            <button class="primary-button" type="button" data-action="report-warning-continue"><i data-lucide="file-output"></i><span>继续导出</span></button>
          </div>
        </section>
      </div>`;
  }
  if (dialog.kind === 'image-pages') {
    return `
      <div class="modal-scrim" role="presentation">
        <section class="md-dialog report-dialog image-pages-dialog" role="dialog" aria-modal="true" aria-labelledby="image-pages-title">
          <div class="dialog-icon"><i data-lucide="images"></i></div>
          <h2 id="image-pages-title">图片报告共 ${dialog.pages.length} 页</h2>
          <p>为避免移动端生成超大图片，本次异常明细按每页最多 20 条拆分。请选择需要保存的页面。</p>
          <div class="image-page-list">${dialog.pages.map((page) => `<button class="secondary-button image-page-button" type="button" data-action="save-report-image-page" data-page-number="${page.pageNumber}"><i data-lucide="image-down"></i><span>保存第 ${page.pageNumber}/${page.pageCount} 页</span></button>`).join('')}</div>
          <div class="dialog-actions"><button class="text-button" type="button" data-action="close-report-dialog">关闭</button></div>
        </section>
      </div>`;
  }
  return '';
}

async function copyText(value, successMessage) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage, 'success');
  } catch {
    showToast('复制失败，可手动选择预览文字复制', 'error');
  }
}

async function saveReportModel(model, format, { pageNumber = null } = {}) {
  const stem = safeFileName(reportFileStem(model, reportExportStamp()));
  if (format === 'xlsx') {
    const plan = planReportXlsxSheet(model);
    const sheet = XLSX.utils.aoa_to_sheet(plan.rows);
    sheet['!merges'] = plan.merges;
    sheet['!cols'] = plan.columns;
    sheet['!autofilter'] = { ref: plan.autoFilterRef };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, plan.sheetName);
    const savedToDirectory = await saveBlob(
      new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${stem}.xlsx`,
    );
    if (!savedToDirectory) showToast('已导出报告 XLSX', 'success');
    return;
  }
  if (format === 'md') {
    const savedToDirectory = await saveBlob(
      new Blob([renderReportMarkdown(model)], { type: 'text/markdown;charset=utf-8' }),
      `${stem}.md`,
    );
    if (!savedToDirectory) showToast('已导出报告 Markdown', 'success');
    return;
  }
  const pages = planReportImagePages(model, { exportStamp: reportExportStamp() });
  const page = pages.find((item) => item.pageNumber === pageNumber) || pages[0];
  const blob = await renderReportImagePage(page, format);
  const savedToDirectory = await saveBlob(blob, `${safeFileName(page.filename)}.${format}`);
  if (!savedToDirectory) showToast(`已导出报告 ${format.toUpperCase()} 第 ${page.pageNumber}/${page.pageCount} 页`, 'success');
}

function beginReportExport(descriptor) {
  if (!descriptor) {
    showToast('请先保存一次查寝，再导出报告', 'error');
    return;
  }
  const result = buildReportFromDescriptor(descriptor);
  if (!result.ok) {
    openReportErrorDialog(result.errors, descriptor);
    return;
  }
  const fingerprint = createReportConfirmationFingerprint(result);
  if (result.warnings.length && !state.confirmedReportFingerprints.has(fingerprint)) {
    openReportWarningDialog(result, descriptor);
    return;
  }
  if (descriptor.format === 'png' || descriptor.format === 'jpg') {
    const pages = planReportImagePages(result.model, { exportStamp: reportExportStamp() });
    if (pages.length > 1) {
      state.reportDialog = { kind: 'image-pages', descriptor, pages };
      render();
      return;
    }
  }
  setBusy(true);
  saveReportModel(result.model, descriptor.format)
    .catch((error) => {
      console.error(error);
      showToast(error.message || '报告导出失败', 'error');
    })
    .finally(() => setBusy(false));
}

function continueReportExport() {
  const descriptor = state.reportDialog?.descriptor;
  const fingerprint = state.reportDialog?.fingerprint;
  const result = buildReportFromDescriptor(descriptor);
  if (!result.ok) {
    openReportErrorDialog(result.errors, descriptor);
    return;
  }
  const currentFingerprint = createReportConfirmationFingerprint(result);
  if (result.warnings.length && currentFingerprint !== fingerprint) {
    openReportWarningDialog(result, descriptor);
    showToast('报告数据已变化，请重新确认重复记录处理。', 'info');
    return;
  }
  state.confirmedReportFingerprints.add(currentFingerprint);
  state.reportDialog = null;
  render();
  beginReportExport(descriptor);
}

function saveReportImagePage(pageNumber) {
  const dialog = state.reportDialog;
  const descriptor = dialog?.descriptor;
  const result = buildReportFromDescriptor(descriptor);
  if (!result.ok) {
    openReportErrorDialog(result.errors, descriptor);
    return;
  }
  const fingerprint = createReportConfirmationFingerprint(result);
  if (result.warnings.length && !state.confirmedReportFingerprints.has(fingerprint)) {
    openReportWarningDialog(result, descriptor);
    return;
  }
  const pages = planReportImagePages(result.model, { exportStamp: reportExportStamp() });
  const page = pages.find((item) => item.pageNumber === Number(pageNumber));
  if (!page) {
    showToast('该报告页已不存在，请重新打开导出。', 'error');
    return;
  }
  setBusy(true);
  saveReportModel(result.model, descriptor.format, { pageNumber: page.pageNumber })
    .catch((error) => {
      console.error(error);
      showToast(error.message || '图片导出失败', 'error');
    })
    .finally(() => setBusy(false));
}

async function copyReport() {
  const descriptor = currentSingleReportDescriptor();
  if (!descriptor) return;
  const result = buildReportFromDescriptor(descriptor);
  if (!result.ok) {
    openReportErrorDialog(result.errors, descriptor);
    return;
  }
  await copyText(renderReportMarkdown(result.model), '报告已复制');
}

async function copyCheckResults() {
  const descriptor = checkModeReportDescriptor();
  const result = buildReportFromDescriptor(descriptor);
  if (!result.ok) {
    openReportErrorDialog(result.errors, descriptor);
    return;
  }
  await copyText(renderReportMarkdown(result.model), '本次查寝结果已复制');
}

function exportReport(format) {
  beginReportExport(currentSingleReportDescriptor(format));
}

function exportCheckResults(format) {
  beginReportExport(checkModeReportDescriptor(format));
}
async function sanitizeBackupPayload(file) {
  if (!file || file.format !== 'dorm-check-local-backup') {
    throw new Error('这不是喵喵查寝备份文件');
  }

  // 判断备份格式版本并提取 payload
  let extractedPayload = file;
  const backupVersion = file.version || 2; // 默认为版本 2（兼容旧格式）

  if (backupVersion === 3) {
    // 版本 3 格式：需要从 payload 字段提取，并可选验证完整性
    if (!file.payload) {
      throw new Error('备份文件格式损坏（缺少 payload 字段）');
    }
    extractedPayload = file.payload;

    // 可选验证：检查完整性校验和
    if (file.integrity?.payloadSha256 && file.integrity.algorithm === 'SHA-256') {
      try {
        const payloadJson = JSON.stringify(extractedPayload);
        const computedSha256 = await sha256(payloadJson);
        if (computedSha256 !== file.integrity.payloadSha256) {
          console.warn('[Backup] 完整性校验失败，但仍继续恢复（可能文件未损坏，仅格式不同）');
        }
      } catch (error) {
        console.warn('[Backup] 无法验证完整性校验和：', error);
        // 不中断恢复流程，允许继续恢复
      }
    }
  } else if (backupVersion !== 2) {
    throw new Error(`不支持的备份格式版本：${backupVersion}`);
  }

  const students = Array.isArray(extractedPayload.students)
    ? extractedPayload.students
        .filter((item) => item && item.id && item.roomNo && item.name)
        .map((item) => ({
          id: sanitizeImportedValue(item.id, 120),
          roomNo: normalizeRoomNo(sanitizeImportedValue(item.roomNo)),
          name: sanitizeImportedValue(item.name),
          className: normalizeClassName(sanitizeImportedValue(item.className)),
          isActive: item.isActive !== false,
          isCommuter: item.isCommuter === true,
          createdAt: sanitizeImportedValue(item.createdAt, 60) || new Date().toISOString(),
          updatedAt: sanitizeImportedValue(item.updatedAt, 60) || new Date().toISOString(),
        }))
    : [];
  const studentIds = new Set(students.map((student) => student.id));

  const sessions = Array.isArray(extractedPayload.sessions)
    ? extractedPayload.sessions
        .filter((item) => item && item.id && item.roomNo && /^\d{4}-\d{2}-\d{2}$/.test(item.businessDate || ''))
        .map((item) => ({
          id: sanitizeImportedValue(item.id, 120),
          roomNo: normalizeRoomNo(sanitizeImportedValue(item.roomNo)),
          businessDate: item.businessDate,
          checkerName: sanitizeImportedValue(item.checkerName, 40),
          status: item.status === 'completed' ? 'completed' : 'draft',
          updatedAt: sanitizeImportedValue(item.updatedAt, 60) || new Date().toISOString(),
          completedAt: sanitizeImportedValue(item.completedAt, 60),
        }))
    : [];
  const sessionIds = new Set(sessions.map((session) => session.id));

  const records = Array.isArray(extractedPayload.records)
    ? extractedPayload.records
        .filter((item) => item && item.id && sessionIds.has(item.sessionId) && studentIds.has(item.studentId))
        .map((item) => ({
          id: sanitizeImportedValue(item.id, 120),
          sessionId: sanitizeImportedValue(item.sessionId, 120),
          studentId: sanitizeImportedValue(item.studentId, 120),
          studentNameSnapshot: sanitizeImportedValue(item.studentNameSnapshot),
          classNameSnapshot: sanitizeImportedValue(item.classNameSnapshot),
          roomNoSnapshot: sanitizeImportedValue(item.roomNoSnapshot),
          status: ['present', 'absent', 'leave'].includes(item.status) ? item.status : 'present',
          remark: sanitizeImportedValue(item.remark, 80),
          updatedAt: sanitizeImportedValue(item.updatedAt, 60) || new Date().toISOString(),
        }))
    : [];

  if (!students.length && !sessions.length && !records.length) {
    throw new Error('备份文件中没有可恢复的数据');
  }
  return {
    checkerName: sanitizeImportedValue(extractedPayload.checkerName, 40),
    students,
    sessions,
    records,
  };
}

async function prepareBackupRestore(file) {
  if (!file || state.isBusy) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast('备份文件过大，当前上限为 10 MB', 'error');
    return;
  }
  setBusy(true);
  try {
    const payload = await sanitizeBackupPayload(JSON.parse(await file.text()));
    state.backupPreview = {
      payload,
      sourceName: file.name,
      students: payload.students.length,
      sessions: payload.sessions.length,
      records: payload.records.length,
    };
    state.route = 'manage';
    render();
    showToast('备份已读取，请确认恢复', 'success');
  } catch (error) {
    showToast(error.message || '备份无法读取', 'error');
  } finally {
    setBusy(false);
  }
}

async function commitBackupRestore() {
  const preview = state.backupPreview;
  if (!preview?.payload || state.isBusy) return;
  setBusy(true);
  state.updateGuard.isRestoringBackup = true;
  try {
    const { payload } = preview;
    await Promise.all([
      dbPutMany(STORES.students, payload.students),
      dbPutMany(STORES.sessions, payload.sessions),
      dbPutMany(STORES.records, payload.records),
      dbPut(STORES.settings, { key: 'checkerName', value: payload.checkerName }),
    ]);
    state.backupPreview = null;
    await refreshData();

    // 记录有意义的活动
    await recordMeaningfulActivity();

    // 更新最后备份时间
    await dbPut(STORES.settings, { key: 'lastBackupTime', value: new Date().toISOString() });
    state.lastBackupTime = new Date();

    render();
    showToast('本地备份已合并恢复', 'success');
  } catch (error) {
    console.error(error);
    if (error.name === 'QuotaExceededError') {
      showToast('存储空间不足，恢复失败', 'error');
    } else {
      showToast('备份恢复失败，本次没有完成写入', 'error');
    }
  } finally {
    state.updateGuard.isRestoringBackup = false;
    setBusy(false);
  }
}

async function chooseArchiveDirectory() {
  if (!window.showDirectoryPicker) {
    showToast('当前浏览器不支持目录写入，将使用下载方式保存', 'info');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const permission = await handle.requestPermission?.({ mode: 'readwrite' });
    if (permission && permission !== 'granted') {
      showToast('没有获得目录写入权限', 'error');
      return;
    }
    state.archiveDirectoryHandle = handle;
    state.archiveDirectoryName = handle.name || '已选择目录';
    try {
      await dbPut(STORES.settings, { key: 'archiveDirectory', value: handle, name: state.archiveDirectoryName });
    } catch (error) {
      console.warn('archive directory handle cannot be persisted', error);
    }
    render();
    showToast(`已设置存档目录：${state.archiveDirectoryName}`, 'success');
  } catch (error) {
    if (error?.name !== 'AbortError') showToast('存档目录设置失败', 'error');
  }
}

async function clearArchiveDirectory() {
  state.archiveDirectoryHandle = null;
  state.archiveDirectoryName = '';
  await dbDelete(STORES.settings, 'archiveDirectory');
  render();
  showToast('已清除存档目录，将使用浏览器下载');
}


function pollUpdateStatus() {
  const bridge = window.AndroidFileBridge;
  if (!bridge || typeof bridge.getUpdateStatus !== 'function') return;
  let status;
  try {
    status = JSON.parse(bridge.getUpdateStatus());
  } catch {
    return;
  }
  if (!status?.state) return;
  state.updateStatus = {
    state: String(status.state),
    message: String(status.message || ''),
  };
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'installing') {
    render();
    clearTimeout(state.updatePollTimer);
    state.updatePollTimer = setTimeout(pollUpdateStatus, 450);
    return;
  }
  render();
  if (status.state === 'ready') showToast(status.message || '新版本已准备好安装', 'success');
  if (status.state === 'error') showToast(status.message || '更新失败', 'error');
}

function checkAppUpdate() {
  if (!supportsNativeUpdate()) return;
  try {
    const response = JSON.parse(window.AndroidFileBridge.checkForUpdate());
    state.updateStatus = { state: String(response.state || 'checking'), message: String(response.message || '正在检查更新') };
    render();
    clearTimeout(state.updatePollTimer);
    state.updatePollTimer = setTimeout(pollUpdateStatus, 250);
  } catch {
    state.updateStatus = { state: 'error', message: '无法启动更新检查' };
    render();
  }
}

function installAppUpdate() {
  if (!supportsNativeUpdate()) return;
  try {
    const response = JSON.parse(window.AndroidFileBridge.installAvailableUpdate());
    state.updateStatus = { state: String(response.state || 'installing'), message: String(response.message || '正在请求系统安装') };
    render();
    clearTimeout(state.updatePollTimer);
    state.updatePollTimer = setTimeout(pollUpdateStatus, 250);
  } catch {
    state.updateStatus = { state: 'error', message: '无法启动系统安装' };
    render();
  }
}

function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || state.isBusy) return;
  const action = target.dataset.action;

  if (action === 'navigate') {
    state.route = normalizeRoute(target.dataset.route);
    state.historySelectedSessionId = '';
    state.joinDialogOpen = false;
    render();
  } else if (action === 'open-join-dialog') {
    state.joinDialogOpen = true;
    render();
  } else if (action === 'close-join-dialog') {
    state.joinDialogOpen = false;
    render();
  } else if (action === 'open-project') {
    state.joinDialogOpen = false;
    window.location.href = GITHUB_PROJECT_URL;
  } else if (action === 'start-check-mode') {
    startCheckMode();
  } else if (action === 'confirm-start-check') {
    confirmStartCheck();
  } else if (action === 'cancel-start-check') {
    cancelStartCheck();
  } else if (action === 'open-attendance') {
    openAttendance(target.dataset.roomNo);
  } else if (action === 'open-commuter') {
    openCommuterManage(target.dataset.roomNo);
  } else if (action === 'toggle-commuter') {
    toggleCommuter(target.dataset.studentId);
  } else if (action === 'set-status') {
    const row = target.closest('[data-student-id]');
    const record = ensureDraftRecord(row?.dataset.studentId);
    if (!record || !VALID_STATUSES.has(target.dataset.status)) return;
    record.status = target.dataset.status;
    if (record.status === 'present') record.remark = '';
    record.updatedAt = new Date().toISOString();
    render();
  } else if (action === 'toggle-remark') {
    const editor = target.closest('.student-actions')?.querySelector('.remark-editor');
    editor?.classList.toggle('is-open');
    editor?.querySelector('input')?.focus();
  } else if (action === 'mark-all-present') {
    markAllPresent();
  } else if (action === 'save-attendance') {
    saveAttendance();
  } else if (action === 'save-and-next') {
    saveAttendance({ navigateAfter: true });
  } else if (action === 'end-check-mode') {
    endCheckMode();
  } else if (action === 'finish-check-mode') {
    finishCheckMode();
  } else if (action === 'copy-check-results') {
    copyCheckResults();
  } else if (action === 'export-check-results') {
    exportCheckResults(target.dataset.format);
  } else if (action === 'filter-attendance') {
    state.attendanceFilter = target.dataset.filter;
    render();
  } else if (action === 'clear-attendance-search') {
    state.attendanceSearch = '';
    render();
  } else if (action === 'select-history') {
    state.historySelectedSessionId = target.dataset.sessionId;
    render();
  } else if (action === 'edit-history') {
    const session = state.sessions.find((item) => item.id === target.dataset.sessionId);
    if (session) openAttendance(session.roomNo, session.businessDate);
  } else if (action === 'reset-history-filters') {
    state.historyDate = '';
    state.historyRoomNo = '';
    state.historySelectedSessionId = '';
    render();
  } else if (action === 'pick-home-date') {
    const input = document.querySelector('#home-date-input');
    input?.showPicker?.();
    input?.focus();
  } else if (action === 'export-backup') {
    exportBackup();
  } else if (action === 'choose-image') {
    document.querySelector('#image-input')?.click();
  } else if (action === 'confirm-import') {
    commitImportPreview();
  } else if (action === 'cancel-import') {
    state.importPreview = null;
    render();
  } else if (action === 'export-roster') {
    exportRoster(target.dataset.format);
  } else if (action === 'export-report') {
    exportReport(target.dataset.format);
  } else if (action === 'choose-archive-directory') {
    chooseArchiveDirectory();
  } else if (action === 'clear-archive-directory') {
    clearArchiveDirectory();
  } else if (action === 'check-app-update') {
    checkAppUpdate();
  } else if (action === 'install-app-update') {
    installAppUpdate();
  } else if (action === 'install-pwa-update') {
    if (state.pwaController?.updateServiceWorker) {
      state.pwaController.updateServiceWorker();
      state.pwaUpdateAvailable = false;
      showToast('正在更新应用，请稍候...', 'info');
      render();
    }
  } else if (action === 'confirm-restore') {
    commitBackupRestore();
  } else if (action === 'cancel-restore') {
    state.backupPreview = null;
    render();
  } else if (action === 'save-checker-name') {
    saveCheckerName();
  } else if (action === 'add-student') {
    addStudent();
  } else if (action === 'delete-room') {
    deleteRoom(target.dataset.roomNo);
  } else if (action === 'copy-report') {
    copyReport();
  } else if (action === 'report-error-back') {
    const scope = state.reportDialog?.descriptor?.scope;
    state.reportDialog = null;
    state.route = scope === 'check-mode' ? 'room-select' : state.historySelectedSessionId ? 'history' : 'attendance';
    render();
  } else if (action === 'report-error-backup') {
    state.reportDialog = null;
    state.route = 'manage';
    render();
  } else if (action === 'report-error-copy') {
    copyText(target.dataset.diagnosticId || '', '诊断编号已复制');
  } else if (action === 'report-warning-cancel' || action === 'close-report-dialog') {
    state.reportDialog = null;
    render();
  } else if (action === 'report-warning-details') {
    if (state.reportDialog?.kind === 'warning') state.reportDialog.showDetails = !state.reportDialog.showDetails;
    render();
  } else if (action === 'report-warning-continue') {
    continueReportExport();
  } else if (action === 'save-report-image-page') {
    saveReportImagePage(target.dataset.pageNumber);
  } else if (action === 'dismiss-backup-reminder') {
    dismissBackupReminder();
  } else if (action === 'request-persistent-storage') {
    requestPersistentStorageUser();
  } else if (action === 'prepare-offline-ocr') {
    prepareOfflineOcrUser();
  }
}

function handleInput(event) {
  if (event.target.matches('#attendance-search')) {
    state.attendanceSearch = event.target.value;
    const cursor = event.target.selectionStart;
    render();
    const input = document.querySelector('#attendance-search');
    input?.focus();
    input?.setSelectionRange(cursor, cursor);
  } else if (event.target.matches('[data-role="remark"]')) {
    const record = ensureDraftRecord(event.target.dataset.studentId);
    if (record) record.remark = event.target.value.slice(0, 80);
  } else if (event.target.matches('#home-date-input')) {
    state.attendanceDate = isValidBusinessDate(event.target.value) ? event.target.value : todayString();
    render();
  } else if (event.target.matches('#history-date')) {
    state.historyDate = event.target.value;
    state.historySelectedSessionId = '';
    render();
  } else if (event.target.matches('#history-room')) {
    state.historyRoomNo = event.target.value;
    state.historySelectedSessionId = '';
    render();
  }
}

function handleChange(event) {
  if (event.target.matches('#excel-input, #image-input')) {
    prepareImportFile(event.target.files?.[0]);
    event.target.value = '';
  } else if (event.target.matches('#backup-input')) {
    prepareBackupRestore(event.target.files?.[0]);
    event.target.value = '';
  }
}

function handleDragAndDrop() {
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      document.body.classList.add('is-dragging');
    }
  });
  document.addEventListener('dragleave', () => document.body.classList.remove('is-dragging'));
  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    document.body.classList.remove('is-dragging');
    const file = event.dataTransfer.files[0];
    if (isSupportedImportFile(file)) prepareImportFile(file);
    else showToast('请拖入支持的名单文件或图片', 'error');
  });
}

async function init() {
  try {
    await refreshData();
    render();
    handleDragAndDrop();

    // iOS 相关初始化
    state.iosStandaloneMode = checkIosStandaloneMode();
    if (state.iosStandaloneMode) {
      // 检查持久化存储和容量
      state.persistentStorageGranted = navigator.storage?.persist ? true : false;
      state.storageEstimate = await updateStorageEstimate();
    }

    // 加载活跃度时间戳和备份提醒状态
    const settingsStore = await dbGetAll(STORES.settings);
    const lastActivityRecord = settingsStore.find(r => r.key === 'lastActivityAt');
    const dismissedRecord = settingsStore.find(r => r.key === 'backupReminderDismissedUntil');

    if (dismissedRecord?.value) {
      state.backupReminderDismissedUntil = dismissedRecord.value;
    }

    if (lastActivityRecord?.value) {
      state.lastActivityAt = lastActivityRecord.value;

      // 检查 5 天备份提醒
      const now = new Date();
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      if (new Date(lastActivityRecord.value) < fiveDaysAgo) {
        const dismissedUntil = dismissedRecord?.value ? new Date(dismissedRecord.value) : null;
        if (!dismissedUntil || now > dismissedUntil) {
          // 应该显示备份提醒
          state.backupReminderDismissedUntil = null;
        }
      }
    }

    const lastBackupRecord = settingsStore.find(r => r.key === 'lastBackupTime');
    if (lastBackupRecord?.value) {
      state.lastBackupTime = new Date(lastBackupRecord.value);
    }

    // 加载 OCR 缓存版本并验证完整性
    const ocrCacheVersionRecord = settingsStore.find(r => r.key === 'ocrCacheVersion');
    if (ocrCacheVersionRecord?.value) {
      state.ocrCacheVersion = ocrCacheVersionRecord.value;
      // 异步验证缓存完整性，不阻塞初始化
      checkOcrCacheIntegrity().then((result) => {
        state.ocrOfflineReady = result.ready;
        if (!result.ready) {
          console.warn('[OCR] Cache integrity check failed, missing:', result.missing);
          // 缓存不完整，清除版本记录
          state.ocrCacheVersion = null;
          dbPut(STORES.settings, { key: 'ocrCacheVersion', value: null })
            .catch(e => console.warn('[OCR] Failed to clear corrupted version:', e));
        }
      }).catch((error) => {
        console.warn('[OCR] Failed to verify cache integrity:', error);
      });
    }

    // 注册 PWA Service Worker
    state.pwaController = await registerCatCheckPwa({
      onOfflineReady() {
        // 首次缓存完成，可显示离线可用提示
        console.info('[App] Offline capability ready');
      },
      onNeedRefresh() {
        // 新版本可用，显示更新 banner
        state.pwaUpdateAvailable = true;
        render();
      },
      updateGuard: state.updateGuard,
    });

    // 监听可见性变化，重新检查 iOS standalone 状态
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        state.iosStandaloneMode = checkIosStandaloneMode();
      }
    });
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="fatal-error"><h1>本地数据库无法打开</h1><p>请使用支持 IndexedDB 的现代浏览器重新打开应用。</p></div>`;
  }
}

app.addEventListener('click', handleClick);
app.addEventListener('input', handleInput);
app.addEventListener('change', handleChange);

init();
