/**
 * Prima 勤怠管理（Google Apps Script）
 *
 * スプレッドシートに紐づけて使います。設置方法は attendance/README.md を参照。
 *
 * シート構成
 *   スタッフ : ID / 名前 / 区分 / PIN / 管理者 / 有効
 *   打刻ログ : 日時 / 日付 / スタッフID / 名前 / 種別 / メモ
 *   集計_YYYY-MM : メニュー「勤怠 > 月次集計を作成」で作られる集計表
 */

const SHEET_STAFF = 'スタッフ';
const SHEET_LOG = '打刻ログ';
const TZ = 'Asia/Tokyo';
const SESSION_SECONDS = 6 * 60 * 60; // ログイン有効時間（CacheService の上限が6時間）
const MAX_FAILS = 5;                 // PIN をこの回数まちがえると
const LOCK_SECONDS = 15 * 60;        // この時間ログインできなくなる

const TYPE = {
  IN: '出勤',
  BREAK_START: '休憩開始',
  BREAK_END: '休憩終了',
  OUT: '退勤',
};

// 状態ごとに押せるボタン
const NEXT_ACTIONS = {
  before: [TYPE.IN],
  working: [TYPE.BREAK_START, TYPE.OUT],
  break: [TYPE.BREAK_END],
  done: [TYPE.IN], // 中抜け後の再出勤を許可
};

const STATE_LABEL = {
  before: '未出勤',
  working: '勤務中',
  break: '休憩中',
  done: '退勤済',
};

/* ------------------------------------------------------------------ */
/* Web アプリ                                                          */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Prima 勤怠')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** ログイン画面の名前一覧 */
function getStaffList() {
  return readStaff_()
    .filter(function (s) { return s.active; })
    .map(function (s) { return { id: s.id, name: s.name }; });
}

/** ID と PIN でログインし、セッショントークンを返す */
function login(id, pin) {
  id = String(id || '').trim();
  pin = String(pin || '').trim();
  if (!id || !pin) throw new Error('名前とPINを入力してください。');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) {
    throw new Error('PINの入力ミスが続いたため、15分間ログインできません。');
  }

  const staff = findStaff_(id);
  if (!staff || !staff.active || !verifyPin_(staff, pin)) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    throw new Error('名前またはPINが正しくありません。');
  }
  cache.remove(failKey);

  const token = Utilities.getUuid();
  cache.put('sess_' + token, staff.id, SESSION_SECONDS);
  return { token: token };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

/** 画面に表示する情報一式 */
function getStatus(token) {
  const me = requireStaff_(token);
  const logs = readLogs_();
  const now = new Date();
  const today = fmtDate_(now);
  const month = Utilities.formatDate(now, TZ, 'yyyy-MM');

  const mine = logs.filter(function (l) { return l.key === me.key; });
  const todayLogs = mine.filter(function (l) { return l.date === today; });
  const state = stateOf_(todayLogs);

  const result = {
    me: { id: me.id, name: me.name, category: me.category, admin: me.admin },
    today: today,
    state: state,
    stateLabel: STATE_LABEL[state],
    nextActions: NEXT_ACTIONS[state],
    todayLogs: todayLogs.map(function (l) {
      return { time: fmtTime_(l.at), type: l.type, note: l.note };
    }),
    month: month,
    monthDays: summarizeByDay_(mine.filter(function (l) {
      return l.date.indexOf(month) === 0;
    })).map(dayToView_),
  };

  if (me.admin) {
    const todayAll = logs.filter(function (l) { return l.date === today; });
    result.board = readStaff_()
      .filter(function (s) { return s.active; })
      .map(function (s) {
        const ls = todayAll.filter(function (l) { return l.key === s.key; });
        const st = stateOf_(ls);
        const first = ls.filter(function (l) { return l.type === TYPE.IN; })[0];
        const outs = ls.filter(function (l) { return l.type === TYPE.OUT; });
        return {
          name: s.name,
          category: s.category,
          stateLabel: STATE_LABEL[st],
          state: st,
          in: first ? fmtTime_(first.at) : '',
          out: st === 'done' && outs.length ? fmtTime_(outs[outs.length - 1].at) : '',
        };
      });
  }
  return result;
}

/** 打刻 */
function punch(token, type, note) {
  const me = requireStaff_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const now = new Date();
    const today = fmtDate_(now);
    const todayLogs = readLogs_().filter(function (l) {
      return l.key === me.key && l.date === today;
    });
    const state = stateOf_(todayLogs);
    if (NEXT_ACTIONS[state].indexOf(type) < 0) {
      throw new Error('今は「' + type + '」を打刻できません（現在：' + STATE_LABEL[state] + '）。');
    }
    const sheet = getSheet_(SHEET_LOG);
    sheet.appendRow([now, today, me.id, me.name, type, String(note || '').slice(0, 200)]);
    sheet.getRange(sheet.getLastRow(), 2, 1, 2).setNumberFormat('@').setValues([[today, me.id]]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return getStatus(token);
}

/* ------------------------------------------------------------------ */
/* スプレッドシートのメニュー                                           */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('勤怠')
    .addItem('初期設定（最初に1回）', 'setup')
    .addItem('月次集計を作成', 'menuMonthlySummary')
    .addToUi();
}

/** シートとヘッダーを作る */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  let staff = ss.getSheetByName(SHEET_STAFF);
  if (!staff) {
    staff = ss.insertSheet(SHEET_STAFF);
    staff.appendRow(['ID', '名前', '区分', 'PIN', '管理者', '有効']);
    staff.appendRow(['001', '校舎長（例）', '社員', '1234', true, true]);
    staff.setFrozenRows(1);
    staff.getRange('A:A').setNumberFormat('@');
    staff.getRange('D:D').setNumberFormat('@');
    staff.getRange('A2').setValue('001');
    staff.getRange('D2').setValue('1234');
    staff.getRange('E2:F2').insertCheckboxes();
    staff.getRange('E2:F2').setValue(true);
  }

  let log = ss.getSheetByName(SHEET_LOG);
  if (!log) {
    log = ss.insertSheet(SHEET_LOG);
    log.appendRow(['日時', '日付', 'スタッフID', '名前', '種別', 'メモ']);
    log.setFrozenRows(1);
    log.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    log.getRange('B:C').setNumberFormat('@');
  }

  salt_(); // PIN 用のソルトを用意
  const done = '初期設定が完了しました。\n「スタッフ」シートに社員・スタッフを登録してください。\n' +
    'PIN は数字で入力すれば、初回ログイン時に自動で暗号化されます。';
  try {
    SpreadsheetApp.getUi().alert(done);
  } catch (e) {
    // Apps Script の画面から「実行」した場合はダイアログを出せないのでログに出す
    console.log(done);
  }
}

function menuMonthlySummary() {
  const ui = SpreadsheetApp.getUi();
  const def = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const res = ui.prompt('月次集計', '集計する月を入力（例：' + def + '）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const month = (res.getResponseText() || def).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    ui.alert('「2026-11」の形式で入力してください。');
    return;
  }
  const name = buildMonthlySummary(month);
  ui.alert('「' + name + '」シートを作成しました。');
}

/** 指定月（yyyy-MM）の集計シートを作る */
function buildMonthlySummary(month) {
  const ss = SpreadsheetApp.getActive();
  const staffList = readStaff_();
  const logs = readLogs_().filter(function (l) { return l.date.indexOf(month) === 0; });

  const detail = [['日付', 'ID', '名前', '区分', '出勤', '退勤', '休憩', '実働', '実働(時間)', '備考']];
  const total = [['ID', '名前', '区分', '出勤日数', '実働合計', '実働合計(時間)', '退勤漏れ']];

  staffList.forEach(function (s) {
    const days = summarizeByDay_(logs.filter(function (l) { return l.key === s.key; }));
    if (!days.length && !s.active) return;
    let workMin = 0;
    let missing = 0;
    days.forEach(function (d) {
      const v = dayToView_(d);
      detail.push([d.date, s.id, s.name, s.category, v.in, v.out, v.break, v.work,
        round2_(d.workMin / 60), v.warning]);
      workMin += d.workMin;
      if (d.open) missing++;
    });
    total.push([s.id, s.name, s.category, days.length, hm_(workMin), round2_(workMin / 60), missing]);
  });

  const name = '集計_' + month;
  let sheet = ss.getSheetByName(name);
  if (sheet) sheet.clear(); else sheet = ss.insertSheet(name);

  // 「001」「2026-11-01」「9:05」などが数値・日付に変換されないよう、文字列の列は書式を先に「@」にする
  sheet.getRange(1, 1).setValue(month + ' 個人別合計').setFontWeight('bold');
  sheet.getRange(2, 1, total.length, 3).setNumberFormat('@');
  sheet.getRange(2, 5, total.length, 1).setNumberFormat('@');
  sheet.getRange(2, 1, total.length, total[0].length).setValues(total);
  sheet.getRange(2, 1, 1, total[0].length).setFontWeight('bold').setBackground('#e8f0fe');

  const top = total.length + 4;
  sheet.getRange(top - 1, 1).setValue(month + ' 日別明細').setFontWeight('bold');
  sheet.getRange(top, 1, detail.length, 8).setNumberFormat('@');
  sheet.getRange(top, 10, detail.length, 1).setNumberFormat('@');
  sheet.getRange(top, 1, detail.length, detail[0].length).setValues(detail);
  sheet.getRange(top, 1, 1, detail[0].length).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.autoResizeColumns(1, detail[0].length);
  return name;
}

/* ------------------------------------------------------------------ */
/* 勤務時間の計算                                                      */
/* ------------------------------------------------------------------ */

/** 打刻の並びから現在の状態を返す */
function stateOf_(dayLogs) {
  if (!dayLogs.length) return 'before';
  const last = dayLogs[dayLogs.length - 1].type;
  if (last === TYPE.BREAK_START) return 'break';
  if (last === TYPE.OUT) return 'done';
  return 'working';
}

/** 打刻ログ（1人分）を日ごとにまとめ、実働・休憩を計算する */
function summarizeByDay_(personLogs) {
  const byDate = {};
  personLogs.forEach(function (l) {
    (byDate[l.date] = byDate[l.date] || []).push(l);
  });
  return Object.keys(byDate).sort().map(function (date) {
    const ls = byDate[date].sort(function (a, b) { return a.at - b.at; });
    let workMs = 0, breakMs = 0, start = null, breakStart = null;
    let firstIn = null, lastOut = null;
    ls.forEach(function (l) {
      const t = l.at.getTime();
      if (l.type === TYPE.IN) {
        if (!firstIn) firstIn = l.at;
        start = t;
      } else if (l.type === TYPE.BREAK_START) {
        if (start !== null) workMs += t - start;
        start = null;
        breakStart = t;
      } else if (l.type === TYPE.BREAK_END) {
        if (breakStart !== null) breakMs += t - breakStart;
        breakStart = null;
        start = t;
      } else if (l.type === TYPE.OUT) {
        if (start !== null) workMs += t - start;
        if (breakStart !== null) breakMs += t - breakStart; // 休憩終了の押し忘れ
        start = null;
        breakStart = null;
        lastOut = l.at;
      }
    });
    return {
      date: date,
      firstIn: firstIn,
      lastOut: lastOut,
      workMin: Math.floor(workMs / 60000),
      breakMin: Math.floor(breakMs / 60000),
      open: start !== null || breakStart !== null, // 退勤していない
      notes: ls.map(function (l) { return l.note; }).filter(String).join(' / '),
    };
  });
}

function dayToView_(d) {
  const isToday = d.date === fmtDate_(new Date());
  return {
    date: d.date,
    in: d.firstIn ? fmtTime_(d.firstIn) : '',
    out: d.lastOut && !d.open ? fmtTime_(d.lastOut) : '',
    break: hm_(d.breakMin),
    work: hm_(d.workMin),
    warning: d.open ? (isToday ? '勤務中' : '退勤漏れ') : '',
    notes: d.notes,
  };
}

/* ------------------------------------------------------------------ */
/* シートの読み書き                                                    */
/* ------------------------------------------------------------------ */

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('「' + name + '」シートがありません。メニュー「勤怠 > 初期設定」を実行してください。');
  return sheet;
}

function readStaff_() {
  const values = getSheet_(SHEET_STAFF).getDataRange().getValues();
  const list = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const id = String(r[0]).trim();
    if (!id) continue;
    list.push({
      row: i + 1,
      id: id,
      key: idKey_(id),
      name: String(r[1]).trim(),
      category: String(r[2]).trim(),
      pin: String(r[3]).trim(),
      admin: r[4] === true || String(r[4]).toUpperCase() === 'TRUE',
      active: r[5] === '' || r[5] === true || String(r[5]).toUpperCase() === 'TRUE',
    });
  }
  return list;
}

function findStaff_(id) {
  const key = idKey_(id);
  return readStaff_().filter(function (s) { return s.key === key; })[0] || null;
}

/** 打刻ログを読む。日付は「日時」列から求める（手で行を足しても正しく集計される） */
function readLogs_() {
  const values = getSheet_(SHEET_LOG).getDataRange().getValues();
  const logs = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const at = r[0] instanceof Date ? r[0] : (r[0] ? new Date(r[0]) : null);
    if (!at || isNaN(at.getTime())) continue;
    logs.push({
      at: at,
      date: fmtDate_(at),
      id: String(r[2]).trim(),
      key: idKey_(r[2]),
      name: String(r[3]),
      type: String(r[4]).trim(),
      note: String(r[5] || ''),
    });
  }
  return logs.sort(function (a, b) { return a.at - b.at; });
}

function requireStaff_(token) {
  const id = token && CacheService.getScriptCache().get('sess_' + token);
  if (!id) throw new Error('SESSION_EXPIRED');
  const staff = findStaff_(id);
  if (!staff || !staff.active) throw new Error('SESSION_EXPIRED');
  return staff;
}

/* ------------------------------------------------------------------ */
/* PIN                                                                 */
/* ------------------------------------------------------------------ */

function salt_() {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('PIN_SALT');
  if (!salt) {
    salt = Utilities.getUuid();
    props.setProperty('PIN_SALT', salt);
  }
  return salt;
}

function hashPin_(id, pin) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt_() + ':' + id + ':' + pin, Utilities.Charset.UTF_8);
  return 'sha256:' + bytes.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

/** PIN を照合。シートに平文で入っていれば、照合成功時にハッシュへ置き換える */
function verifyPin_(staff, pin) {
  if (!staff.pin) return false;
  if (staff.pin.indexOf('sha256:') === 0) return staff.pin === hashPin_(staff.id, pin);
  if (staff.pin !== pin) return false;
  getSheet_(SHEET_STAFF).getRange(staff.row, 4).setValue(hashPin_(staff.id, pin));
  return true;
}

/* ------------------------------------------------------------------ */
/* 書式                                                                */
/* ------------------------------------------------------------------ */

/** 「001」と「1」を同じ ID として扱う（シートで先頭の0が消えても照合できるように） */
function idKey_(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}

function fmtDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function fmtTime_(d) { return Utilities.formatDate(d, TZ, 'H:mm'); }
function hm_(min) { return Math.floor(min / 60) + ':' + ('0' + (min % 60)).slice(-2); }
function round2_(n) { return Math.round(n * 100) / 100; }
