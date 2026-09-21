export const REPORT_STATUS_META = Object.freeze({
  present: { label: '到', order: 2 },
  absent: { label: '未到', order: 0 },
  leave: { label: '请假', order: 1 },
});

const VALID_SCOPES = new Set(['session', 'check-mode']);

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function isValidBusinessDate(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T12:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function parseReportStatus(value) {
  return Object.hasOwn(REPORT_STATUS_META, value) ? value : null;
}

function diagnostic(code, message, details = {}, severity = 'error') {
  return { code, severity, message, ...details };
}

function dateTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stableSortByRoom(left, right) {
  return compareText(left.roomNo, right.roomNo) || compareText(left.id, right.id);
}

function selectDuplicateRecord(current, candidate) {
  const currentTime = dateTime(current.updatedAt);
  const candidateTime = dateTime(candidate.updatedAt);
  if (currentTime !== null && candidateTime !== null && candidateTime > currentTime) {
    return { record: candidate, resolution: 'latest-updated-at' };
  }
  if (currentTime !== null && candidateTime !== null && candidateTime < currentTime) {
    return { record: current, resolution: 'latest-updated-at' };
  }
  return { record: candidate, resolution: 'last-input-order' };
}

function reportRow(record, sessionById, studentsById) {
  const session = sessionById.get(record.sessionId);
  const student = studentsById.get(record.studentId);
  const status = parseReportStatus(record.status);
  const snapshotName = cleanText(record.studentNameSnapshot);
  const snapshotClass = cleanText(record.classNameSnapshot);
  const snapshotRoom = cleanText(record.roomNoSnapshot);
  const name = snapshotName || cleanText(student?.name) || '未知学生';
  const className = snapshotClass || cleanText(student?.className) || '未分班';
  const roomNo = snapshotRoom || cleanText(student?.roomNo) || cleanText(session?.roomNo) || '未分配';

  return {
    sessionId: record.sessionId,
    roomNo,
    studentId: record.studentId,
    name,
    className,
    status,
    statusLabel: REPORT_STATUS_META[status].label,
    remark: status === 'present' ? '' : cleanText(record.remark),
  };
}

function groupDiagnostics(errors) {
  return errors.sort((left, right) => {
    const code = compareText(left.code, right.code);
    if (code !== 0) return code;
    return compareText(left.sessionId, right.sessionId) || compareText(left.studentId, right.studentId);
  });
}

export function buildAttendanceReportModel(input = {}) {
  const errors = [];
  const warnings = [];
  const scope = input?.scope;
  const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const records = Array.isArray(input?.records) ? input.records : null;
  const students = Array.isArray(input?.students) ? input.students : [];

  if (!VALID_SCOPES.has(scope)) {
    errors.push(diagnostic('invalid-scope', '导出范围无效，请返回后重新选择。'));
  }
  if (!sessions.length) {
    errors.push(diagnostic('empty-session-selection', '没有已完成的查寝记录可导出。'));
  }
  if (scope === 'session' && sessions.length !== 1) {
    errors.push(diagnostic('invalid-scope', '单次报告必须恰好包含一个查寝会话。'));
  }
  if (records === null) {
    errors.push(diagnostic('invalid-record', '查寝记录数据无效，未生成文件。', { details: { reason: 'records-not-array' } }));
  }

  const validSessions = [];
  const sessionIds = new Set();
  sessions.forEach((session, index) => {
    const id = cleanText(session?.id);
    const roomNo = cleanText(session?.roomNo);
    const businessDate = cleanText(session?.businessDate);
    if (!id || !roomNo || !isValidBusinessDate(businessDate) || session?.status !== 'completed') {
      const reason = !id
        ? 'missing-id'
        : !isValidBusinessDate(businessDate)
          ? 'invalid-business-date'
          : !roomNo
            ? 'missing-room-no'
            : 'not-completed';
      errors.push(diagnostic('invalid-session', '存在无效或未完成的查寝会话，未生成文件。', {
        sessionId: id || undefined,
        details: { index, reason },
      }));
      return;
    }
    if (sessionIds.has(id)) {
      errors.push(diagnostic('duplicate-session', '导出范围包含重复会话，未生成文件。', { sessionId: id }));
      return;
    }
    sessionIds.add(id);
    validSessions.push({ ...session, id, roomNo, businessDate, checkerName: cleanText(session.checkerName) });
  });

  if (scope === 'check-mode' && validSessions.length > 1) {
    const dates = new Set(validSessions.map((session) => session.businessDate));
    if (dates.size !== 1) {
      errors.push(diagnostic('mixed-business-date', '一次汇总报告只能包含同一查寝日期的会话。'));
    }
  }

  const validRecords = [];
  (records || []).forEach((record, index) => {
    const sessionId = cleanText(record?.sessionId);
    const studentId = cleanText(record?.studentId);
    const status = parseReportStatus(record?.status);
    if (!sessionId || !studentId || !status) {
      errors.push(diagnostic('invalid-record', '存在无法识别的查寝记录，未生成文件。', {
        sessionId: sessionId || undefined,
        studentId: studentId || undefined,
        details: { index, reason: !sessionId ? 'missing-session-id' : !studentId ? 'missing-student-id' : 'invalid-status' },
      }));
      return;
    }
    if (!sessionIds.has(sessionId)) {
      errors.push(diagnostic('unexpected-record-session', '导出数据范围不一致，未生成文件。', {
        sessionId,
        studentId,
      }));
      return;
    }
    validRecords.push({ ...record, sessionId, studentId, status });
  });

  if (errors.length) return { ok: false, errors: groupDiagnostics(errors), warnings };

  const selectedRecords = new Map();
  validRecords.forEach((record) => {
    const key = `${record.sessionId}\u0000${record.studentId}`;
    const previous = selectedRecords.get(key);
    if (!previous) {
      selectedRecords.set(key, { record, inputCount: 1, resolution: null });
      return;
    }
    const selected = selectDuplicateRecord(previous.record, record);
    selectedRecords.set(key, {
      record: selected.record,
      inputCount: previous.inputCount + 1,
      resolution: selected.resolution,
    });
  });

  const sessionById = new Map(validSessions.map((session) => [session.id, session]));
  const studentsById = new Map(
    students
      .filter((student) => cleanText(student?.id))
      .map((student) => [cleanText(student.id), student]),
  );
  const rows = [...selectedRecords.entries()].map(([key, selected]) => {
    if (selected.inputCount > 1) {
      const [sessionId, studentId] = key.split('\u0000');
      const session = sessionById.get(sessionId);
      warnings.push(diagnostic(
        'duplicate-record',
        `${session?.roomNo || '未知寝室'} 寝的 1 名学生存在 ${selected.inputCount} 条重复记录，已保留${selected.resolution === 'latest-updated-at' ? '最新修改' : '原始顺序最后'}的记录。`,
        {
          sessionId,
          studentId,
          details: {
            inputCount: selected.inputCount,
            retainedRecordId: cleanText(selected.record.id) || undefined,
            resolution: selected.resolution,
          },
        },
        'warning',
      ));
    }
    return reportRow(selected.record, sessionById, studentsById);
  });

  rows.sort((left, right) =>
    compareText(left.roomNo, right.roomNo)
    || REPORT_STATUS_META[left.status].order - REPORT_STATUS_META[right.status].order
    || compareText(left.name, right.name)
    || compareText(left.studentId, right.studentId),
  );

  const summary = rows.reduce(
    (counts, row) => ({ ...counts, [row.status]: counts[row.status] + 1, expected: counts.expected + 1 }),
    { expected: 0, present: 0, absent: 0, leave: 0 },
  );
  const exceptionRows = rows.filter((row) => row.status !== 'present');
  if (summary.expected !== summary.present + summary.absent + summary.leave || summary.expected !== rows.length || exceptionRows.length !== rows.filter((row) => row.status !== 'present').length) {
    errors.push(diagnostic('invariant-violation', '汇总和明细无法对应，未生成文件。', {
      details: { expected: summary.expected, rowCount: rows.length },
    }));
  }
  if (errors.length) return { ok: false, errors: groupDiagnostics(errors), warnings };

  const sortedSessions = [...validSessions].sort(stableSortByRoom);
  const rooms = [...new Set(sortedSessions.map((session) => session.roomNo))].sort(compareText);
  const checkerNames = [...new Set(sortedSessions.map((session) => session.checkerName || '未填写查寝人'))].sort(compareText);
  const businessDate = sortedSessions[0]?.businessDate || '';
  const generatedAt = cleanText(input.generatedAt) || new Date().toISOString();

  return {
    ok: true,
    warnings: groupDiagnostics(warnings),
    model: {
      scope,
      generatedAt,
      metadata: {
        businessDate,
        rooms,
        sessionCount: sortedSessions.length,
        checkerNames,
        sessions: sortedSessions.map((session) => ({
          sessionId: session.id,
          roomNo: session.roomNo,
          checkerName: session.checkerName || '未填写查寝人',
        })),
      },
      summary,
      rows,
      exceptionRows,
    },
  };
}

export function createReportConfirmationFingerprint({ model, warnings = [] }) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, normalize(value[key])]));
    }
    return value;
  };
  return JSON.stringify(normalize({
    scope: model.scope,
    metadata: {
      businessDate: model.metadata.businessDate,
      rooms: model.metadata.rooms,
      sessions: model.metadata.sessions,
    },
    summary: model.summary,
    rows: model.rows,
    warnings,
  }));
}
