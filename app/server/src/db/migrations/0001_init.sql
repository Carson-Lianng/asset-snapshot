-- ============================================================
-- 0001_init —— 初始建表（技术设计文档 §6.2 / §6.4）
--
-- 约定：
--   * 金额 / 汇率 / 本金列一律 INTEGER，单位「微元」（1 元 = 1_000_000）
--   * 金额列的 REAL 用法在本库被彻底禁止（PRD §3.4.3）
--   * 由 Drizzle schema.ts 镜像，本文件是权威 DDL
--   * PRAGMA（journal_mode / foreign_keys / …）在连接层设置，
--     不能放进迁移事务（journal_mode 在事务内是无效操作）
-- ============================================================

-- ---------- 设置 ----------
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 关键键：base_currency、schema_version
INSERT INTO setting (key, value) VALUES ('schema_version', '1');

-- ---------- 币种与汇率 ----------
CREATE TABLE currency (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  symbol  TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE exchange_rate (
  currency_code TEXT PRIMARY KEY REFERENCES currency(code) ON DELETE CASCADE,
  rate_to_base  INTEGER NOT NULL,            -- 微元
  updated_at    TEXT NOT NULL
);

CREATE TABLE base_currency_history (
  id              TEXT PRIMARY KEY,
  from_currency   TEXT NOT NULL,
  to_currency     TEXT NOT NULL,
  conversion_rate INTEGER NOT NULL,          -- 1 旧本位币 = R 新本位币，微元
  changed_at      TEXT NOT NULL
);

-- ---------- 平台 / 分类 / 标签 ----------
CREATE TABLE platform (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL DEFAULT 'other',
  note    TEXT NOT NULL DEFAULT '',
  sort    INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE category (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK (type IN ('asset', 'liability')),
  -- 对应 PRD §3.1.5 / §5.6（R-04）：新建该分类下的账户时默认是否开启「跟踪本金」
  default_track_principal INTEGER NOT NULL DEFAULT 0 CHECK (default_track_principal IN (0, 1)),
  sort                    INTEGER NOT NULL DEFAULT 0,
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE tag (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

-- ---------- 账户 ----------
CREATE TABLE account (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  platform_id          TEXT REFERENCES platform(id) ON DELETE SET NULL,
  category_id          TEXT NOT NULL REFERENCES category(id),
  type                 TEXT NOT NULL CHECK (type IN ('asset', 'liability')),
  currency             TEXT NOT NULL REFERENCES currency(code),
  note                 TEXT NOT NULL DEFAULT '',
  include_in_net_worth INTEGER NOT NULL DEFAULT 1 CHECK (include_in_net_worth IN (0, 1)),
  track_principal      INTEGER NOT NULL DEFAULT 0 CHECK (track_principal IN (0, 1)),
  sort                 INTEGER NOT NULL DEFAULT 0,
  archived             INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  -- 只有资产账户才允许跟踪本金（PRD §3.1.5）
  CHECK (track_principal = 0 OR type = 'asset')
);

CREATE TABLE account_tag (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, tag_id)
);

-- ---------- 快照 ----------
CREATE TABLE snapshot (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,           -- YYYY-MM-DD
  note              TEXT NOT NULL DEFAULT '',
  base_currency     TEXT NOT NULL,
  -- 三个汇总列是快照的「冻结口径」，必须与当时写入的明细严格一致：
  -- 实时重算会随汇率表变化而漂移（PRD 规则 3 / 规则 4）
  total_assets      INTEGER NOT NULL,        -- 微元
  total_liabilities INTEGER NOT NULL,        -- 微元
  net_worth         INTEGER NOT NULL,        -- 微元
  created_at        TEXT NOT NULL
);

CREATE TABLE snapshot_item (
  id                     TEXT PRIMARY KEY,
  snapshot_id            TEXT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  -- 刻意不加外键：账户删除不得连带删除历史明细（PRD 规则 6）。
  -- CASCADE 会删掉历史，RESTRICT 会让账户永远删不掉，因此保留裸 ID 且允许为空。
  account_id             TEXT,
  account_name_snapshot  TEXT NOT NULL,
  platform_id_snapshot   TEXT,               -- 跨期匹配键
  platform_name_snapshot TEXT,
  category_id_snapshot   TEXT NOT NULL,      -- 跨期匹配键
  category_name_snapshot TEXT NOT NULL,
  type                   TEXT NOT NULL CHECK (type IN ('asset', 'liability')),
  currency               TEXT NOT NULL,
  original_amount        INTEGER NOT NULL,   -- 微元
  exchange_rate          INTEGER NOT NULL,   -- 微元标度
  amount_in_base         INTEGER NOT NULL,   -- 微元
  include_in_net_worth   INTEGER NOT NULL CHECK (include_in_net_worth IN (0, 1)),
  tracks_principal       INTEGER NOT NULL DEFAULT 0 CHECK (tracks_principal IN (0, 1)),
  principal              INTEGER,            -- 可空：未填本金
  principal_in_base      INTEGER,            -- 可空
  is_carried_over         INTEGER NOT NULL DEFAULT 0 CHECK (is_carried_over IN (0, 1)),
  tags_snapshot          TEXT NOT NULL DEFAULT '[]',
  sort                   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE snapshot_rate (
  snapshot_id  TEXT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL,
  rate_to_base INTEGER NOT NULL,             -- 微元
  PRIMARY KEY (snapshot_id, currency)
);

-- ---------- 盘点草稿（全局唯一一行） ----------
CREATE TABLE inventory_draft (
  id         TEXT PRIMARY KEY CHECK (id = 'current'),
  version    INTEGER NOT NULL DEFAULT 1,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- 索引（技术设计文档 §6.4）
-- ============================================================

-- 趋势图与快照列表：按日期倒序，同日按创建时间取最后一张（规则 16）
CREATE INDEX idx_snapshot_date      ON snapshot(date DESC, created_at DESC);
-- 明细渲染
CREATE INDEX idx_item_snapshot_sort ON snapshot_item(snapshot_id, sort);
-- 资产 / 负债汇总下推
CREATE INDEX idx_item_snapshot_type ON snapshot_item(snapshot_id, type, include_in_net_worth);
-- 收益上期基准查找（规则 20）
CREATE INDEX idx_item_account       ON snapshot_item(account_id);
-- 跨期对比按 ID 匹配（规则 8）
CREATE INDEX idx_item_platform      ON snapshot_item(snapshot_id, platform_id_snapshot);
CREATE INDEX idx_item_category      ON snapshot_item(snapshot_id, category_id_snapshot);
-- 账户列表
CREATE INDEX idx_account_active     ON account(archived, sort);
CREATE INDEX idx_account_platform   ON account(platform_id);
CREATE INDEX idx_account_category   ON account(category_id);
-- 标签反查
CREATE INDEX idx_account_tag_tag    ON account_tag(tag_id);
-- 折算链按时间排序
CREATE INDEX idx_bch_changed        ON base_currency_history(changed_at);
