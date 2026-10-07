/**
 * DataTabs.tsx —— 设置页的「导入导出」与「备份恢复」（Step 5）
 *
 * 这两组和其余五组写路径不是一回事：其余五组都是「一次 JSON 调用」，
 * 而它们要的是**文件流与整库替换**（下载走原始字节见 I-30、导入要读用户选的文件、
 * 恢复是整体覆盖），所以单独成文件。
 *
 * ## 三个决定
 *
 * 1. **落盘用原始字节**（`dataSource().download()` 返回 `ArrayBuffer`）。
 *    `Response.text()` 会剥掉 CSV 开头的 BOM，Excel 打开就是乱码 ——
 *    而这个错误在浏览器里「看起来是对的」。详见 `DownloadedFile.bytes`。
 *
 * 2. **导入的差异预览来自服务端，不在前端算**。前端只负责把文件读成文本、
 *    把 `{ inserted, updated, conflicts }` 画出来。判定「平台不存在」「币种未启用」
 *    需要当前字典，前端算就等于把这些规则实现两遍。
 *
 * 3. **不在界面上提供「清空为演示数据」**。原型那一格是 `重置为演示数据`，
 *    接通后它会把用户全部真实资产换成演示数据 —— 一次误点的代价太大，
 *    而真实使用频率是「一年零次」。改为在卡片里写明命令行做法（`npm run reset`），
 *    用一个必须手输 `--yes` 的门槛换掉一个随手可点的按钮。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import type {
  BackupListDTO,
  BackupResultDTO,
  ImportApplyDTO,
  ImportPreviewDTO,
  RestoreResultDTO,
  SettingsDTO,
  SnapshotSummaryDTO
} from '@app/shared';
import { dataSource, ep, mutate, useApi, writable } from '../../api/index.ts';
import { messageOf } from '../../api/problem.ts';
import { downloadFile } from '../../lib/download.ts';
import { useToast } from '../../components/Toast.tsx';
import { ConfirmModal } from '../../components/Modal.tsx';
import { Note } from '../../components/Atoms.tsx';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============================================================
   导入导出
   ============================================================ */

export function IoPanel({ snapshotList }: { snapshotList: readonly SnapshotSummaryDTO[] }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [snapId, setSnapId] = useState('');
  const canWrite = writable();

  const latest = snapshotList.length ? snapshotList[0] : null;
  const targetSnap = snapshotList.find(s => s.id === snapId) ?? latest;

  const doExport = async (path: string, fallback: string, mime: string, label: string) => {
    setBusy(true);
    try {
      await downloadFile(path, fallback, mime);
      toast(`${label}已开始下载`, 'ok', 3000);
    } catch (err) {
      toast(messageOf(err), 'err', 4200);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 清掉 value，否则连续选同一个文件不会再触发 change
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const content = await file.text();
      const pv = await dataSource().send<ImportPreviewDTO>('POST', '/import/preview', {
        filename: file.name,
        content
      });
      setPending({ name: file.name, content });
      setPreview(pv);
    } catch (err) {
      setPending(null);
      setPreview(null);
      toast(messageOf(err), 'err', 4200);
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await mutate(ds =>
        ds.send<ImportApplyDTO>('POST', '/import/apply', {
          filename: pending.name,
          content: pending.content
        })
      );
      toast(`导入完成：新增 ${res.inserted} 条 · 更新 ${res.updated} 条`, 'ok', 4200);
      setPending(null);
      setPreview(null);
    } catch (err) {
      toast(messageOf(err), 'err', 5200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-hd">
          <h3>导出</h3>
          <span className="sub">数据自持，随时可搬走</span>
        </div>
        <div className="btn-row">
          <button
            className="btn pri"
            disabled={busy}
            onClick={() =>
              doExport('/export/full', 'asset-snapshot.json', 'application/json', '全量备份')
            }
          >
            导出全量备份（JSON）
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              doExport(
                ep.exportCsv('items', targetSnap?.id),
                'asset-items.csv',
                'text/csv;charset=utf-8',
                '快照明细'
              )
            }
          >
            导出快照明细（CSV）
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              doExport('/export/csv?type=summary', 'asset-summary.csv', 'text/csv;charset=utf-8', '汇总报表')
            }
          >
            导出汇总报表（CSV）
          </button>
          {snapshotList.length > 1 && (
            <select
              className="inp"
              style={{ maxWidth: 190 }}
              value={targetSnap?.id ?? ''}
              onChange={e => setSnapId(e.target.value)}
              title="导出哪一期快照的明细"
            >
              {snapshotList.map(s => (
                <option key={s.id} value={s.id}>
                  {s.date}
                </option>
              ))}
            </select>
          )}
        </div>
        <Note tone="info" style={{ marginTop: 14 }}>
          全量备份包含 <span className="mono">schema_version</span>、
          <span className="mono">app_version</span>、<span className="mono">exported_at</span>，
          以及设置、币种、汇率、平台、分类、标签、账户与全部快照。
        </Note>
      </div>

      <div className="card">
        <div className="card-hd">
          <h3>导入账户</h3>
          <span className="sub">按「账户名 + 平台」匹配，存在则更新</span>
        </div>
        <Note tone="warn">
          导入只建立 / 更新<b>账户档案</b>（含分类、币种、备注）。<b>余额不写入快照</b> ——
          金额要经过盘点向导的三态录入、冻结汇率与保存前门禁，这些步骤不能从 CSV 绕过。
        </Note>
        <Note style={{ marginTop: 8 }}>
          表头需要包含 <span className="mono">账户名</span>；可选{' '}
          <span className="mono">平台</span>、<span className="mono">分类</span>、
          <span className="mono">币种</span>、<span className="mono">类型</span>、
          <span className="mono">备注</span>、<span className="mono">金额</span>。
          分类 / 平台 / 币种必须已在设置页建好，否则该行会报冲突。
        </Note>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={onFile}
        />
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy || !canWrite} onClick={() => fileRef.current?.click()}>
            选择文件…
          </button>
          {pending && <span className="panel-hint">已读取：{pending.name}</span>}
        </div>

        {preview && (
          <>
            <div className="tbl-wrap" style={{ marginTop: 12 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>行</th>
                    <th>账户名</th>
                    <th>平台</th>
                    <th>币种</th>
                    <th className="num">余额（不导入）</th>
                    <th className="mid">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map(r => (
                    <tr key={r.line}>
                      <td className="num">{r.line}</td>
                      <td>{r.account_name || '—'}</td>
                      <td>{r.platform_name || '—'}</td>
                      <td>{r.currency || '—'}</td>
                      <td className="num">{r.amount === null ? '—' : r.amount.toFixed(2)}</td>
                      <td className="mid">
                        {r.action === 'insert' ? (
                          <span className="badge ok">新增</span>
                        ) : r.action === 'update' ? (
                          <span className="badge warn">更新</span>
                        ) : r.action === 'conflict' ? (
                          <span className="badge dup">冲突</span>
                        ) : (
                          <span className="badge mute">跳过</span>
                        )}
                        {r.reason && <div className="panel-hint">{r.reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.truncated && (
              <Note style={{ marginTop: 8 }}>
                只列出前 {preview.rows.length} 行，其余不计入表格，但计数是完整的。
              </Note>
            )}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <span className="badge ok">新增 {preview.inserted}</span>
              <span className="badge warn">更新 {preview.updated}</span>
              {preview.conflicts > 0 && <span className="badge dup">冲突 {preview.conflicts}</span>}
              {preview.skipped > 0 && <span className="badge mute">跳过 {preview.skipped}</span>}
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn" disabled={busy} onClick={() => { setPending(null); setPreview(null); }}>
                取消
              </button>
              <button
                className="btn ink"
                disabled={busy || preview.conflicts > 0 || preview.inserted + preview.updated === 0}
                onClick={doApply}
                title={preview.conflicts > 0 ? '有冲突行，需先修正文件' : undefined}
              >
                确认导入
              </button>
            </div>
            {preview.conflicts > 0 && (
              <Note tone="err" style={{ marginTop: 8 }}>
                有 {preview.conflicts} 行无法导入，整体不会写入任何数据。请按「冲突」列的原因修正后重试。
              </Note>
            )}
          </>
        )}
      </div>
    </>
  );
}

/* ============================================================
   备份恢复
   ============================================================ */

type PendingRestore =
  | { kind: 'file'; name: string }
  | { kind: 'json'; doc: unknown; filename: string };

export function BackupPanel({
  settings,
  snapshotCount,
  accountCount
}: {
  settings: SettingsDTO | null;
  snapshotCount: number;
  accountCount: number;
}) {
  const toast = useToast();
  const list = useApi<BackupListDTO>(ep.backups());
  const jsonRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PendingRestore | null>(null);
  const canWrite = writable();

  const items = list.data?.items ?? [];

  const doBackup = async () => {
    setBusy(true);
    try {
      const r = await mutate(ds => ds.send<BackupResultDTO>('POST', '/backup'));
      toast(
        `已备份：${r.name}（${fmtSize(r.size)}）${r.pruned ? ` · 清理 ${r.pruned} 份旧备份` : ''}`,
        'ok',
        4200
      );
    } catch (err) {
      toast(messageOf(err), 'err', 5200);
    } finally {
      setBusy(false);
    }
  };

  /** 下载式「导出当前备份」：与「立即备份」的区别是它把文件交给用户带走 */
  const doExportJson = async () => {
    setBusy(true);
    try {
      await downloadFile(ep.exportFull(), 'asset-snapshot.json', 'application/json');
      toast('全量备份已开始下载', 'ok', 3000);
    } catch (err) {
      toast(messageOf(err), 'err', 4200);
    } finally {
      setBusy(false);
    }
  };

  const onJsonFile = async (e: ChangeEvent<HTMLInputElement>) => {    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const doc: unknown = JSON.parse(await file.text());
      setConfirm({ kind: 'json', doc, filename: file.name });
    } catch {
      toast('这不是合法的 JSON 文件', 'err', 4200);
    }
  };

  const doRestore = async (target: PendingRestore) => {
    setBusy(true);
    try {
      const body = target.kind === 'file' ? { backup_name: target.name } : { document: target.doc };
      const res = await mutate(ds => ds.send<RestoreResultDTO>('POST', '/restore', body));
      toast(
        `恢复完成：账户 ${res.restored.accounts} · 快照 ${res.restored.snapshots} · 明细 ${res.restored.snapshot_items}`,
        'ok',
        5200
      );
      if (res.pre_restore_backup) {
        toast(`恢复前的数据已留底：${res.pre_restore_backup}`, 'info', 7000);
      }
    } catch (err) {
      toast(messageOf(err), 'err', 6500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-hd">
          <h3>备份与恢复</h3>
          <span className="sub">单端本地应用，备份文件是唯一的迁移手段</span>
        </div>
        <Note tone="warn">
          恢复将<b>覆盖当前全部数据</b>。恢复前系统会自动留一份「恢复前备份」，但请勿依赖它代替你自己的导出。
        </Note>
        <div className="grid3" style={{ marginTop: 14 }}>
          <div className="kv">
            <span className="kk">schema_version</span>
            <span className="vv">{settings?.schema_version ?? '—'}</span>
            <span className="kk">app_version</span>
            <span className="vv">{settings?.app_version ?? '—'}</span>
          </div>
          <div className="kv">
            <span className="kk">快照期数</span>
            <span className="vv">{snapshotCount}</span>
            <span className="kk">账户数</span>
            <span className="vv">{accountCount}</span>
          </div>
          <div className="kv">
            <span className="kk">自动备份</span>
            <span className="vv">每日一次 + 每次保存快照后</span>
            <span className="kk">保留份数</span>
            <span className="vv">{list.data?.keep ?? '—'}</span>
          </div>
        </div>

        <div className="hr" />
        <div className="btn-row">
          <button className="btn pri" disabled={busy || !canWrite} onClick={doBackup}>
            立即备份
          </button>
          <button
            className="btn"
            disabled={busy || !canWrite}
            onClick={() => void doExportJson()}
          >
            导出当前备份（下载）
          </button>
          <button className="btn" disabled={busy || !canWrite} onClick={() => jsonRef.current?.click()}>
            从 JSON 文件恢复…
          </button>
          <input
            ref={jsonRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={onJsonFile}
          />
        </div>

        <div className="hr" />
        {items.length === 0 ? (
          <Note>
            还没有任何备份文件。启动时与每次保存快照后会自动备份一份，也可以点上面的「立即备份」。
          </Note>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>备份文件</th>
                  <th className="num">大小</th>
                  <th>生成时间</th>
                  <th className="mid">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map(b => (
                  <tr key={b.name}>
                    <td className="mono">
                      {b.name}
                      {b.is_today && <span className="badge ok" style={{ marginLeft: 8 }}>今日</span>}
                    </td>
                    <td className="num">{fmtSize(b.size)}</td>
                    <td>{fmtTime(b.created_at)}</td>
                    <td className="mid">
                      <button
                        className="btn sm"
                        disabled={busy || !canWrite}
                        onClick={() => setConfirm({ kind: 'file', name: b.name })}
                      >
                        从此备份恢复
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Note tone="info" style={{ marginTop: 14 }}>
          恢复时的版本校验：版本相同直接恢复；版本较低自动执行字段迁移；无法迁移则明确报错并终止，
          <b>不写入任何数据</b>。
        </Note>
      </div>

      <div className="card">
        <div className="card-hd">
          <h3>危险操作</h3>
        </div>
        <Note tone="warn">
          清空全部数据<b>不在界面上提供</b> —— 一次误点的代价是全部资产记录，而它一年也用不上一次。
          需要重置时请在项目目录运行：
        </Note>
        <div className="mono" style={{ marginTop: 10, fontSize: 13 }}>
          npm run reset -- --yes
        </div>
        <div className="panel-hint" style={{ marginTop: 6 }}>
          清空账户与全部快照，保留币种 / 汇率 / 平台 / 分类 / 标签字典，建成一份空白账本。
          不带 <span className="mono">--yes</span> 时只打印影响范围。
        </div>
        <div className="panel-hint" style={{ marginTop: 4 }}>
          想回到演示数据则用 <span className="mono">npm run db:seed -- --yes</span>（同样会清空现有数据）。
        </div>
      </div>

      {confirm && (
        <ConfirmModal
          title="确认恢复"
          okText="覆盖并恢复"
          body={
            confirm.kind === 'file' ? (
              <>
                将用备份文件 <b className="mono">{confirm.name}</b> 覆盖当前全部数据。
                <br />
                当前 {accountCount} 个账户与 {snapshotCount} 期快照会被替换为备份里的内容。
              </>
            ) : (
              <>
                将用文件 <b className="mono">{confirm.filename}</b> 的内容覆盖当前全部数据。
                <br />
                当前 {accountCount} 个账户与 {snapshotCount} 期快照会被替换为备份里的内容。
              </>
            )
          }
          onOk={() => void doRestore(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
