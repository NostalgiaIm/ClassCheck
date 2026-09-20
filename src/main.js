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
import './style.css';

const DB_NAME = 'dorm-check-local';
const DB_VERSION = 3;

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
};

const app = document.querySelector('#app');
let dbPromise;
let ocrWorkerPromise;

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

function normalizeRoomNo(value) {
  return String(value || '').trim() || '未分配';
}

function normalizeClassName(value) {
  return String(value || '').trim() || '未分班';
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

function buildReport(session, records = getSessionRecords(session.id), students = getRoomStudents(session.roomNo, false)) {
  const studentById = new Map(students.map((student) => [student.id, student]));
  const counts = getCounts(records);
  const expected = records.length;
  const actual = counts.present;
  const leave = counts.leave;
  const checker = session.checkerName || state.checkerName || '未填写查寝人';
  const lines = [
    `${formatReportDate(session.businessDate)}${session.roomNo}寝（${checker}）`,
    `应到 ${expected} 人实到 ${actual} 人，${leave} 人请假已核实`,
  ];

  const reportMembers = records.map((record) => {
    const student = studentById.get(record.studentId);
    return {
      record,
      className: student?.className || record.classNameSnapshot || '未分班',
      name: student?.name || record.studentNameSnapshot || '未知学生',
    };
  });

  const leaveByClass = new Map();
  reportMembers
    .filter(({ record }) => record.status === 'leave')
    .forEach(({ className, name }) => {
      if (!leaveByClass.has(className)) leaveByClass.set(className, []);
      leaveByClass.get(className).push(name);
    });

  const classNames = [...new Set([
    ...students.map((student) => student.className || '未分班'),
    ...reportMembers.map((member) => member.className),
  ])].sort(compareText);

  classNames.forEach((className) => {
    const names = leaveByClass.get(className) || [];
    lines.push(`${className} ${names.join('、')}`.trimEnd());
  });

  return lines.join('\n');
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

  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-brand-row">
          <div class="brand-mark"><img src="/icons/catcheck-icon.png" alt="" /></div>
          <h1 class="topbar-title">喵喵查寝</h1>
          <span class="topbar-balance" aria-hidden="true"></span>
        </div>
        <nav class="top-nav" aria-label="主导航">
          ${navItems
            .map(
              ([route, icon, label]) => `
              <button type="button" class="nav-item${state.route === route ? ' is-active' : ''}" data-action="navigate" data-route="${route}">
                <i data-lucide="${icon}" aria-hidden="true"></i>
                <span>${label}</span>
              </button>`,
            )
            .join('')}
        </nav>
      </header>
      <main class="main-content">${content}</main>
      <div id="toast-root" aria-live="polite"></div>
      ${state.startDialogOpen ? renderStartDialog() : ''}
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
          <input type="text" id="start-checker-name" value="${escapeHtml(state.checkerName)}" maxlength="20" placeholder="例如：张三" autofocus />
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
      <button class="text-button today-manage-link" type="button" data-action="navigate" data-route="manage">
        <i data-lucide="settings-2"></i><span>管理名单</span>
      </button>
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

  const reportText = draft?.status === 'completed' ? buildReport(draft, draft.records, getRoomStudents(draft.roomNo, false)) : '';

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
                ${recordStatus !== 'present' ? `<label class="reason-field">${recordStatus === 'leave' ? '请假原因' : '未到原因'}
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
        ${
          state.attendanceSearch
            ? `<button type="button" data-action="clear-attendance-search" aria-label="清除搜索"><i data-lucide="x"></i></button>`
            : ''
        }
      </label>
      <div class="filter-tabs">
        ${[['all', '全部'], ['absent', '未到'], ['leave', '请假']]
          .map(
            ([filter, label]) =>
              `<button type="button" class="${state.attendanceFilter === filter ? 'is-active' : ''}" data-action="filter-attendance" data-filter="${filter}">${label}</button>`,
          )
          .join('')}
      </div>
    </section>
    <section class="student-list-section">
      <div class="list-heading"><span>宿舍成员</span><span>${filtered.length} 人显示中</span></div>
      <div class="student-list">${list}</div>
      <div class="save-bar" aria-label="查寝保存操作">
        <button class="secondary-button" type="button" data-action="save-attendance"><i data-lucide="save"></i><span>保存</span></button>
        <button class="primary-button save-button" type="button" data-action="save-and-next">
          <i data-lucide="${state.checkMode ? 'arrow-right' : 'save'}"></i><span>${state.checkMode ? '下一个寝室' : '更新保存'}</span>
        </button>
      </div>
      ${
        reportText
          ? `<div class="report-panel">
              <div class="detail-header">
                <div>
                  <p class="section-kicker">REPORT TEXT</p>
                  <h3>汇报文字</h3>
                </div>
                ${renderReportActions()}
              </div>
              <pre id="report-text">${escapeHtml(reportText)}</pre>
            </div>`
          : ''
      }
    </section>
  `;
}

function getCheckModeSessions() {
  const date = state.checkMode?.date || state.attendanceDate;
  const ids = new Set(state.checkMode?.sessionIds || []);
  return state.sessions.filter((session) => session.businessDate === date && ids.has(session.id));
}

function getCheckModeReports() {
  return getCheckModeSessions().map((session) => buildReport(session, getSessionRecords(session.id), getRoomStudents(session.roomNo, false)));
}

function renderExport() {
  const reports = getCheckModeReports();
  const text = reports.join('\n\n');
  return `
    <section class="page-header export-header">
      <button class="back-button" type="button" data-action="navigate" data-route="room-select" title="返回宿舍选择"><i data-lucide="arrow-left"></i></button>
      <div class="page-header-copy"><p class="section-kicker">EXPORT</p><h2>导出查寝结果</h2><p>${formatDate(state.checkMode?.date || state.attendanceDate, true)} · ${reports.length} 个宿舍</p></div>
      <span class="local-pill"><i data-lucide="hard-drive-download"></i>本机生成</span>
    </section>
    <section class="export-summary-card"><div class="export-summary-icon"><i data-lucide="file-check-2"></i></div><div><strong>本次查寝已结束</strong><p>请选择一种格式保存全部宿舍的查寝结果。</p></div></section>
    <section class="report-panel export-report-panel"><div class="detail-header"><div><p class="section-kicker">PREVIEW</p><h3>汇报预览</h3></div><button class="secondary-button" type="button" data-action="copy-check-results"><i data-lucide="copy"></i><span>复制全部</span></button></div><pre id="report-text">${escapeHtml(text || '暂无已保存的查寝结果')}</pre></section>
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
  const selectedSession = state.historySelectedSessionId
    ? state.sessions.find((session) => session.id === state.historySelectedSessionId)
    : null;
  const selectedRecords = selectedSession ? getSessionRecords(selectedSession.id) : [];
  const selectedStudents = selectedSession ? getRoomStudents(selectedSession.roomNo, false) : [];
  const reportText = selectedSession ? buildReport(selectedSession, selectedRecords, selectedStudents) : '';
  const selectedRows = selectedSession
    ? selectedRecords
        .map((record) => {
          const student = selectedStudents.find((item) => item.id === record.studentId);
          return { record, student };
        })
        .sort((a, b) => compareText(a.student?.className, b.student?.className) || compareText(a.student?.name, b.student?.name))
        .map(
          ({ record, student }) => `
          <div class="history-student-row">
            <span class="room-badge">${escapeHtml(student?.className || record.classNameSnapshot || '未分班')}</span>
            <div class="history-student-name">
              <strong>${escapeHtml(student?.name || record.studentNameSnapshot || '未知学生')}</strong>
              <span>${escapeHtml(student?.roomNo || record.roomNoSnapshot || '')} 寝</span>
            </div>
            <span class="history-status status-${STATUS_META[record.status]?.tone || 'present'}">
              <i data-lucide="${STATUS_META[record.status]?.icon || 'circle'}"></i>${STATUS_META[record.status]?.label || record.status}
            </span>
            ${record.remark ? `<span class="history-remark">${escapeHtml(record.remark)}</span>` : ''}
          </div>
        `,
        )
        .join('')
    : '';

  return `
    <section class="page-header">
      <div class="page-header-copy">
        <p class="section-kicker">ARCHIVE</p>
        <h2>历史记录</h2>
        <p>按日期和宿舍号查看本机保存的查寝结果。</p>
      </div>
      <span class="local-pill"><i data-lucide="database"></i>本地数据库</span>
    </section>
    <section class="history-filters">
      <label class="field-label">日期
        <input type="date" id="history-date" value="${state.historyDate}" />
      </label>
      <label class="field-label">宿舍号
        <select id="history-room">
          <option value="">全部宿舍</option>
          ${rooms.map((room) => `<option value="${escapeHtml(room.roomNo)}"${room.roomNo === state.historyRoomNo ? ' selected' : ''}>${escapeHtml(room.roomNo)} 寝</option>`).join('')}
        </select>
      </label>
      <button class="secondary-button filter-reset" type="button" data-action="reset-history-filters">
        <i data-lucide="rotate-ccw"></i><span>清除</span>
      </button>
    </section>
    <section class="history-layout">
      <div class="history-list-panel">
        <div class="list-heading"><span>查寝批次</span><span>${filteredSessions.length} 条</span></div>
        ${
          filteredSessions.length
            ? `<div class="history-list">${filteredSessions
                .map((session) => {
                  const records = getSessionRecords(session.id);
                  const counts = getCounts(records);
                  return `
                    <button class="history-card${session.id === state.historySelectedSessionId ? ' is-selected' : ''}" type="button" data-action="select-history" data-session-id="${session.id}">
                      <div class="history-card-date"><strong>${formatDate(session.businessDate)}</strong><span>${session.status === 'completed' ? '已保存' : '草稿'}</span></div>
                      <h3>${escapeHtml(session.roomNo)} 寝</h3>
                      <div class="mini-counts"><span class="status-present">实到 ${counts.present}</span><span class="status-absent">未到 ${counts.absent}</span><span class="status-leave">请假 ${counts.leave}</span></div>
                    </button>
                  `;
                })
                .join('')}</div>`
            : `<div class="empty-state"><div class="empty-icon"><i data-lucide="calendar-off"></i></div><h3>暂无历史记录</h3><p>完成第一次查寝后，记录会出现在这里。</p></div>`
        }
      </div>
      <div class="history-detail-panel">
        ${
          selectedSession
            ? `
            <div class="detail-header">
              <div>
                <p class="section-kicker">${formatDate(selectedSession.businessDate, true)}</p>
                <h3>${escapeHtml(selectedSession.roomNo)} 寝</h3>
              </div>
              <button class="icon-button" type="button" data-action="edit-history" data-session-id="${selectedSession.id}" aria-label="编辑这次查寝" title="编辑这次查寝"><i data-lucide="pencil"></i></button>
            </div>
            <div class="detail-counts">
              ${Object.entries(getCounts(selectedRecords))
                .map(([status, count]) => `<div class="detail-count ${STATUS_META[status].tone}"><strong>${count}</strong><span>${STATUS_META[status].label}</span></div>`)
                .join('')}
            </div>
            <div class="report-panel compact-report">
              <div class="detail-header">
                <div><p class="section-kicker">REPORT TEXT</p><h3>汇报文字</h3></div>
                ${renderReportActions()}
              </div>
              <pre id="report-text">${escapeHtml(reportText)}</pre>
            </div>
            <div class="history-student-list">${selectedRows || '<div class="empty-state"><p>没有保存的学生记录。</p></div>'}</div>
          `
            : `
            <div class="empty-state empty-state-detail">
              <div class="empty-icon"><i data-lucide="mouse-pointer-click"></i></div>
              <h3>选择一条记录</h3>
              <p>查看该次查寝的完整名单和生成文字。</p>
            </div>
          `
        }
      </div>
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
    showToast('保存失败，请重试', 'error');
    return null;
  } finally {
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
    return { ...current, status: 'present', updatedAt: new Date().toISOString() };
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
        workerPath: '/ocr/worker.min.js',
        corePath: '/ocr/core',
        langPath: '/ocr/lang',
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
    render();
    showToast(`导入完成，新增 ${added} 人，更新 ${updated} 人`, 'success');
  } catch (error) {
    console.error(error);
    showToast('导入写入失败，本次没有完成导入', 'error');
  } finally {
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

function safeSpreadsheetCell(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text.trim()) ? `'${text}` : text;
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

function exportBackup() {
  const payload = {
    format: 'dorm-check-local-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
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
  saveBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
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

function reportContext() {
  if (state.route === 'attendance' && state.attendanceDraft) {
    return {
      session: state.attendanceDraft,
      records: state.attendanceDraft.records,
      students: getRoomStudents(state.attendanceDraft.roomNo, false),
    };
  }
  const session = state.sessions.find((item) => item.id === state.historySelectedSessionId);
  if (!session) return null;
  return {
    session,
    records: getSessionRecords(session.id),
    students: getRoomStudents(session.roomNo, false),
  };
}

async function reportToImage(report, format) {
  const lines = report.split('\n');
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = Math.max(320, 100 + lines.length * 54);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#17242f';
  context.font = '32px "Microsoft YaHei", "SimSun", sans-serif';
  lines.forEach((line, index) => context.fillText(line, 56, 78 + index * 54));
  return new Promise((resolve) => canvas.toBlob(resolve, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92));
}

async function exportReport(format) {
  const context = reportContext();
  const report = document.querySelector('#report-text')?.textContent || (context ? buildReport(context.session, context.records, context.students) : '');
  if (!report) {
    showToast('请先保存一次查寝，再导出汇报文字', 'error');
    return;
  }

  const baseName = safeFileName(`查寝汇报_${context?.session?.businessDate || todayString()}_${context?.session?.roomNo || '宿舍'}`);
  let blob;
  let filename;
  if (format === 'png' || format === 'jpg') {
    blob = await reportToImage(report, format);
    filename = `${baseName}.${format}`;
  } else if (format === 'xlsx') {
    const rows = report.split('\n').map((line, index) => ({ 序号: index + 1, 汇报内容: safeSpreadsheetCell(line) }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '汇报文字');
    blob = new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    filename = `${baseName}.xlsx`;
  } else {
    blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
    filename = `${baseName}.md`;
  }
  const savedToDirectory = await saveBlob(blob, filename);
  if (!savedToDirectory) showToast(`已导出汇报 ${format.toUpperCase()}`, 'success');
}

async function copyCheckResults() {
  const report = getCheckModeReports().join('\n\n');
  if (!report) {
    showToast('当前还没有已保存的宿舍结果', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(report);
    showToast('本次查寝结果已复制', 'success');
  } catch {
    showToast('复制失败，可手动选择预览文字复制', 'error');
  }
}

async function exportCheckResults(format) {
  const reports = getCheckModeReports();
  const report = reports.join('\n\n');
  if (!report) {
    showToast('请至少保存一个寝室后再导出', 'error');
    return;
  }
  const date = state.checkMode?.date || state.attendanceDate;
  const baseName = safeFileName(`查寝汇报_${date}_${state.checkMode?.checkerName || '查寝人'}`);
  let blob;
  let filename;
  if (format === 'png' || format === 'jpg') {
    blob = await reportToImage(report, format);
    filename = `${baseName}.${format}`;
  } else if (format === 'xlsx') {
    const rows = report.split('\n').map((line, index) => ({ 序号: index + 1, 汇报内容: safeSpreadsheetCell(line) }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '查寝汇报');
    blob = new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    filename = `${baseName}.xlsx`;
  } else {
    blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
    filename = `${baseName}.md`;
  }
  const savedToDirectory = await saveBlob(blob, filename);
  if (!savedToDirectory) showToast(`已导出本次查寝 ${format.toUpperCase()}`, 'success');
}

function sanitizeBackupPayload(payload) {
  if (!payload || payload.format !== 'dorm-check-local-backup') {
    throw new Error('这不是喵喵查寝备份文件');
  }

  const students = Array.isArray(payload.students)
    ? payload.students
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

  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions
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

  const records = Array.isArray(payload.records)
    ? payload.records
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
    checkerName: sanitizeImportedValue(payload.checkerName, 40),
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
    const payload = sanitizeBackupPayload(JSON.parse(await file.text()));
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
    render();
    showToast('本地备份已合并恢复', 'success');
  } catch (error) {
    console.error(error);
    showToast('备份恢复失败，本次没有完成写入', 'error');
  } finally {
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

async function copyReport() {
  const report = document.querySelector('#report-text')?.textContent || '';
  if (!report) return;
  try {
    await navigator.clipboard.writeText(report);
    showToast('汇报文字已复制', 'success');
  } catch {
    showToast('复制失败，可手动选择文字复制', 'error');
  }
}

function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || state.isBusy) return;
  const action = target.dataset.action;

  if (action === 'navigate') {
    state.route = normalizeRoute(target.dataset.route);
    state.historySelectedSessionId = '';
    render();
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
    if ('serviceWorker' in navigator && !window.AndroidFileBridge) {
      navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('service worker unavailable', error));
    }
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="fatal-error"><h1>本地数据库无法打开</h1><p>请使用支持 IndexedDB 的现代浏览器重新打开应用。</p></div>`;
  }
}

app.addEventListener('click', handleClick);
app.addEventListener('input', handleInput);
app.addEventListener('change', handleChange);

init();
