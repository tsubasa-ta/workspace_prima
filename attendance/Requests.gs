/**
 * 有給休暇・休日出勤の申請と承認
 *
 * シート「申請」: 申請ID / 申請日時 / スタッフID / 名前 / 種別 / 対象日 / 日数 / 理由 / 状態 / 承認者 / 処理日時 / コメント
 *
 * スタッフシートの追加列
 *   G 承認者      : チェックした人（社長）が申請を承認・却下できる
 *   H 有給付与日数 : 今の付与期間に付与された有給の日数（繰越分を含む）
 *   I 付与日      : 今の付与期間の開始日。この日以降に承認された有給を「使用済み」として数える
 *   J メール      : 入力すると、申請・承認の通知メールが届く（空欄なら通知なし）
 */

const SHEET_REQ = '申請';

const REQ_TYPE = {
  PAID_FULL: '有給（1日）',
  PAID_AM: '有給（午前半休）',
  PAID_PM: '有給（午後半休）',
  HOLIDAY_WORK: '休日出勤',
};

const REQ_DAYS = {
  '有給（1日）': 1,
  '有給（午前半休）': 0.5,
  '有給（午後半休）': 0.5,
  '休日出勤': 1,
};

const REQ_STATUS = {
  PENDING: '申請中',
  APPROVED: '承認',
  REJECTED: '却下',
  CANCELLED: '取消',
};

const STAFF_HEADERS = ['ID', '名前', '区分', 'PIN', '管理者', '有効', '承認者', '有給付与日数', '付与日', 'メール'];
const REQ_HEADERS = ['申請ID', '申請日時', 'スタッフID', '名前', '種別', '対象日', '日数', '理由', '状態', '承認者', '処理日時', 'コメント'];

/* ------------------------------------------------------------------ */
/* Web アプリから呼ぶ関数                                              */
/* ------------------------------------------------------------------ */

/** 申請する */
function submitRequest(token, type, date, reason) {
  const me = requireStaff_(token);
  ensureRequestSchema_();
  if (!REQ_DAYS[type]) throw new Error('申請の種類を選んでください。');
  date = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('対象日を選んでください。');
  reason = String(reason || '').trim().slice(0, 200);
  if (type === REQ_TYPE.HOLIDAY_WORK && !reason) throw new Error('休日出勤の理由を入力してください。');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let req;
  try {
    const active = readRequests_().filter(function (r) {
      return r.key === me.key && r.date === date &&
        (r.status === REQ_STATUS.PENDING || r.status === REQ_STATUS.APPROVED);
    });
    if (isPaid_(type)) {
      const paidThatDay = active.filter(function (r) { return isPaid_(r.type); });
      const sum = paidThatDay.reduce(function (a, r) { return a + r.days; }, 0);
      const same = paidThatDay.some(function (r) { return r.type === type; });
      if (same || sum + REQ_DAYS[type] > 1) throw new Error(date + ' はすでに有給を申請しています。');
      const bal = leaveBalance_(me);
      if (bal && bal.remaining - bal.pending < REQ_DAYS[type]) {
        throw new Error('有給の残日数が足りません（残り ' + bal.remaining + ' 日、申請中 ' + bal.pending + ' 日）。');
      }
    } else if (active.some(function (r) { return r.type === type; })) {
      throw new Error(date + ' はすでに休日出勤を申請しています。');
    }

    req = {
      id: Utilities.getUuid().slice(0, 8),
      at: new Date(),
      staffId: me.id,
      name: me.name,
      type: type,
      date: date,
      days: REQ_DAYS[type],
      reason: reason,
    };
    const sheet = getSheet_(SHEET_REQ);
    sheet.appendRow([req.id, req.at, '', req.name, req.type, '', req.days, req.reason, REQ_STATUS.PENDING, '', '', '']);
    const row = sheet.getLastRow();
    sheet.getRange(row, 3).setNumberFormat('@').setValue(req.staffId);
    sheet.getRange(row, 6).setNumberFormat('@').setValue(req.date);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  notifyApprovers_(req);
  return getStatus(token);
}

/** 自分の「申請中」の申請を取り消す */
function cancelRequest(token, requestId) {
  const me = requireStaff_(token);
  updateRequest_(requestId, function (r) {
    if (r.key !== me.key) throw new Error('自分の申請だけ取り消せます。');
    if (r.status !== REQ_STATUS.PENDING) throw new Error('「申請中」の申請だけ取り消せます。');
    return { status: REQ_STATUS.CANCELLED, approver: me.name, comment: '本人が取消' };
  });
  return getStatus(token);
}

/** 承認者が承認・却下する */
function decideRequest(token, requestId, approve, comment) {
  const me = requireStaff_(token);
  if (!me.approver) throw new Error('承認の権限がありません。');
  const r = updateRequest_(requestId, function (r) {
    if (r.status !== REQ_STATUS.PENDING) throw new Error('この申請はすでに処理されています（' + r.status + '）。');
    return {
      status: approve ? REQ_STATUS.APPROVED : REQ_STATUS.REJECTED,
      approver: me.name,
      comment: String(comment || '').trim().slice(0, 200),
    };
  });
  notifyRequester_(r);
  return getStatus(token);
}

/** getStatus() に申請まわりの情報を足す */
function addRequestInfo_(result, me) {
  ensureRequestSchema_();
  const all = readRequests_();
  result.reqTypes = [REQ_TYPE.PAID_FULL, REQ_TYPE.PAID_AM, REQ_TYPE.PAID_PM, REQ_TYPE.HOLIDAY_WORK];
  result.leave = leaveBalance_(me, all);
  result.myRequests = all
    .filter(function (r) { return r.key === me.key; })
    .sort(function (a, b) { return b.at - a.at; })
    .slice(0, 20)
    .map(reqToView_);

  if (me.approver || me.admin) {
    const staff = readStaff_();
    result.approvals = {
      canApprove: me.approver,
      pending: all
        .filter(function (r) { return r.status === REQ_STATUS.PENDING; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; })
        .map(function (r) {
          const v = reqToView_(r);
          const s = staff.filter(function (x) { return x.key === r.key; })[0];
          const bal = s && isPaid_(r.type) ? leaveBalance_(s, all) : null;
          v.balance = bal ? bal.remaining : null;
          return v;
        }),
      recent: all
        .filter(function (r) { return r.status !== REQ_STATUS.PENDING; })
        .sort(function (a, b) { return (b.decidedAt || b.at) - (a.decidedAt || a.at); })
        .slice(0, 15)
        .map(reqToView_),
    };
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 有給の残日数                                                        */
/* ------------------------------------------------------------------ */

/** 付与日数が未設定の人は null（残日数を管理しない） */
function leaveBalance_(staff, all) {
  if (staff.paidGranted === null) return null;
  all = all || readRequests_();
  const since = staff.grantDate || '0000-00-00';
  let used = 0, pending = 0;
  all.forEach(function (r) {
    if (r.key !== staff.key || !isPaid_(r.type) || r.date < since) return;
    if (r.status === REQ_STATUS.APPROVED) used += r.days;
    if (r.status === REQ_STATUS.PENDING) pending += r.days;
  });
  return {
    granted: staff.paidGranted,
    grantDate: staff.grantDate,
    used: used,
    pending: pending,
    remaining: staff.paidGranted - used,
  };
}

function isPaid_(type) { return String(type).indexOf('有給') === 0; }

/* ------------------------------------------------------------------ */
/* シートの読み書き                                                    */
/* ------------------------------------------------------------------ */

/** 申請シートとスタッフシートの追加列を用意する（何度呼んでもよい） */
function ensureRequestSchema_() {
  const ss = SpreadsheetApp.getActive();
  const staff = ss.getSheetByName(SHEET_STAFF);
  if (staff && staff.getRange(1, 7).getValue() === '') {
    staff.getRange(1, 1, 1, STAFF_HEADERS.length).setValues([STAFF_HEADERS]);
    staff.getRange('I:I').setNumberFormat('yyyy-mm-dd');
  }
  if (!ss.getSheetByName(SHEET_REQ)) {
    const sheet = ss.insertSheet(SHEET_REQ);
    sheet.appendRow(REQ_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
    sheet.getRange('K:K').setNumberFormat('yyyy/mm/dd hh:mm');
    sheet.getRange('C:C').setNumberFormat('@');
    sheet.getRange('F:F').setNumberFormat('@');
  }
}

function readRequests_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_REQ);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!v[0]) continue;
    const at = parseAt_(v[1]);
    const date = v[5] instanceof Date ? fmtDate_(v[5]) : (parseAt_(v[5]) ? fmtDate_(parseAt_(v[5])) : '');
    list.push({
      row: i + 1,
      id: String(v[0]),
      at: at || new Date(0),
      staffId: String(v[2]).trim(),
      key: idKey_(v[2]),
      name: String(v[3]),
      type: String(v[4]).trim(),
      date: date,
      days: Number(v[6]) || REQ_DAYS[String(v[4]).trim()] || 0,
      reason: String(v[7] || ''),
      status: String(v[8]).trim(),
      approver: String(v[9] || ''),
      decidedAt: parseAt_(v[10]),
      comment: String(v[11] || ''),
    });
  }
  return list;
}

/** 申請1件を書き換える。change(r) が返した状態・承認者・コメントを書き込む */
function updateRequest_(requestId, change) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const r = readRequests_().filter(function (x) { return x.id === String(requestId); })[0];
    if (!r) throw new Error('申請が見つかりません。');
    const c = change(r);
    const now = new Date();
    getSheet_(SHEET_REQ).getRange(r.row, 9, 1, 4).setValues([[c.status, c.approver, now, c.comment]]);
    SpreadsheetApp.flush();
    r.status = c.status;
    r.approver = c.approver;
    r.comment = c.comment;
    r.decidedAt = now;
    return r;
  } finally {
    lock.releaseLock();
  }
}

function reqToView_(r) {
  const d = r.date ? r.date.split('-') : null;
  const w = r.date ? '日月火水木金土'.charAt(new Date(Date.UTC(+d[0], +d[1] - 1, +d[2])).getUTCDay()) : '';
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    date: r.date,
    dateLabel: d ? Number(d[1]) + '/' + Number(d[2]) + '（' + w + '）' : '',
    days: r.days,
    reason: r.reason,
    status: r.status,
    approver: r.approver,
    comment: r.comment,
    requestedAt: Utilities.formatDate(r.at, TZ, 'M/d H:mm'),
  };
}

/* ------------------------------------------------------------------ */
/* 通知メール（メール列が空欄の人には送らない）                         */
/* ------------------------------------------------------------------ */

function notifyApprovers_(req) {
  const to = readStaff_()
    .filter(function (s) { return s.approver && s.email; })
    .map(function (s) { return s.email; });
  if (!to.length) return;
  sendMail_(to.join(','),
    '【勤怠】' + req.name + ' さんから' + req.type + 'の申請があります',
    req.name + ' さんから申請がありました。\n\n' +
    '種別：' + req.type + '\n対象日：' + req.date + '\n理由：' + (req.reason || '（なし）') + '\n\n' +
    '勤怠ページで承認・却下してください。\n' + appUrl_());
}

function notifyRequester_(r) {
  const s = findStaff_(r.staffId);
  if (!s || !s.email) return;
  sendMail_(s.email,
    '【勤怠】' + r.type + '（' + r.date + '）が' + r.status + 'されました',
    r.name + ' さん\n\n' + r.date + ' の' + r.type + 'の申請が「' + r.status + '」されました。\n' +
    (r.comment ? 'コメント：' + r.comment + '\n' : '') + '\n' + appUrl_());
}

function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail(to, subject, body);
  } catch (e) {
    console.warn('通知メールを送れませんでした: ' + e.message); // メールが送れなくても申請は止めない
  }
}

function appUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}
