# Pi Extensions — Kiến trúc (baseline; D3/D5 còn mở theo khuyến nghị)

> Trạng thái: các mục đánh dấu **ĐÃ CHỐT** là quyết định đã lock (decision record
> `docs/decisions/0008-pi-extensions-architecture.md`). Phần còn lại là thiết kế chi tiết để implement.
> Nguồn tham khảo: docs `@earendil-works/pi-coding-agent@0.78` (local trong `../pi-vcc/node_modules`),
> repo `../pi-vcc/`, `../pi-memory-md/`, `pifydev/shell-background` (MIT),
> notes dsh `@deepseek-ai/dsh-tool-fs-search` (Sec-lab/quick-research/noted/dsh-glob-grep-notes.md).

## 1. Mục tiêu & phạm vi

Một repo (`pi-utilities`) chứa **nhiều extension cho Pi coding agent**, mỗi extension là 1 entry
point TypeScript đăng ký tools qua `pi.registerTool()`. Đợt đầu:

1. **fs-search** — tools `grep` + `glob` theo semantics dsh (ripgrep, argv thuần, cap cứng).
2. **shell-bg** — `bash` nền: override built-in `bash` với lifecycle background + `shell_status` + `shell_kill`.

Kiến trúc phải để mở cho "vài tools khác" chưa liệt kê: mỗi extension một module độc lập,
share một lớp core thuần (không phụ thuộc pi) để test riêng.

## 2. Bức tranh tổng thể

```
pi-utilities/
├── extensions/                 # pi glue — mỗi file = 1 extension entry, import pi API
│   ├── fs-search.ts            #   registerTool: grep (override), glob
│   └── shell-bg.ts             #   override bash + shell_status + shell_kill + /shell-bg
├── src/                        # logic thuần, KHÔNG import pi packages (test standalone)
│   ├── common/
│   │   ├── subprocess.ts       #   spawn argv-only: timeout+grace, caps, abort, exit-code map
│   │   ├── settings.ts         #   settings 1 file: scaffold/merge ~/.pi/agent/pi-utils.json
│   │   ├── rg-resolver.ts      #   PATH → pi binDir (getAgentDir()/bin) → error hint
│   │   └── tempfile.ts         #   spill toàn văn khi truncate (os.tmpdir + tự clean)
│   ├── fs-search/
│   │   ├── grep-core.ts        #   build rg argv, parse, group theo file, "Line N:" format
│   │   ├── glob-core.ts        #   list → filter semantics → stat mtime → sort → cap
│   │   ├── caps.ts             #   globMaxResults/grepMaxMatches/grepMaxLineBytes/…
│   │   └── format.ts           #   output text cho LLM (inline page + spill locator)
│   └── shell-bg/
│       ├── registry.ts         #   Job map + JSON sidecar (atomic) + pid reconciliation
│       ├── spawn.ts            #   cross-platform spawn-to-file, drain-safe
│       ├── kill.ts             #   terminate process tree (detached group)
│       ├── tail.ts             #   đọc N bytes cuối log
│       ├── pending.ts          #   message khi background + khi deliver (2 mode UI/headless)
│       ├── format.ts           #   status/result/list rendering
│       └── config.ts           #   settings resolve + defaults (autoBackgroundMs, tailBytes…)
├── tests/                      # bun:test — unit src/ + glue test với fake ExtensionAPI
├── package.json                # pi.extensions: [./extensions/fs-search.ts, ./extensions/shell-bg.ts]
└── tsconfig.json / biome.json
```

Nguyên tắc phân lớp (học từ pify/shell-background và pi-vcc):

- **`src/` không import `@earendil-works/*`** → typecheck + unit test không cần pi runtime,
  dễ CI, dễ port. `extensions/` chỉ là lớp mỏng glue (register tool, hook event, render, deliver).
- **State tool lưu trong `details` của tool result** (branching-safe theo docs pi) + sidecar JSON
  cho state sống qua `/reload`.
- **Mọi output về LLM đều cap + truncate** bằng `truncateHead/truncateTail` của pi
  (limit 50KB / 2000 lines), quá thì spill ra temp file kèm locator.

## 3. Extension 1 — fs-search (`grep` + `glob`)

### 3.1 Semantics (theo notes dsh, giữ nguyên intent)

| Hành vi | grep | glob |
|---|---|---|
| Args | `pattern` (rg regex), `path?`, `include?` | `pattern`, `path?` |
| Phạm vi | hidden + gitignored, loại VCS metadata (`.git/`) | như grep |
| Output | header đếm match + group theo file, `Line N: <preview>` → feed `read offset` | paths tương đối workdir, sort mtime ascending |
| Caps | 250 match, 2000 bytes/line preview, 20MB raw stdout | 100 paths inline |
| Empty | exit 1 của rg = **thành công, rỗng** | tương tự |
| Timeout | 30s + grace 3s terminate tree | như grep |
| Shell | **không** — argv thuần | như grep |

Sai khác so với built-in `grep`/`find` của pi (lý do tồn tại): built-in tôn trọng gitignore,
không sort mtime, không có semantics "pattern không có `/` = basename mọi độ sâu",
không force include-hidden. Đây là tool **discovery** (tìm bug trốn trong ignored files),
không thay thế `find` built-in.

### 3.2 Đặt tên — ĐÃ CHỐT: `grep` override, `glob` tên mới

- Override **`grep`** với schema superset: giữ `glob, ignoreCase, literal, context, limit` của built-in
  + thêm `include` (alias của `glob`, semantics dsh) + `noIgnore` (default `true` — tinh thần discovery của dsh;
  mô tả tool nói rõ để model opt-out khi repo lớn).
- **`glob`** là tên mới (không có built-in trùng tên). Built-in `find` giữ nguyên — muốn tắt thì
  `pi.setActiveTools()` lúc config, không làm trong extension.
- Vì chọn override: implementation base = **fork `grep.js` của pi** (MIT) để giữ streaming JSON +
  early-kill-đủ-limit + context-lines, rồi thêm flags dsh (`--no-config`, `--no-ignore` + exclude `.git`,
  timeout 30s + grace 3s).

### 3.3 Implement rg

- `--no-config` luôn prepend (chặn `RIPGREP_CONFIG_PATH` inject `--pre`).
- grep: `rg --json --no-config --hidden --no-ignore -g '!.git' [--include→-g] <pattern> <path>`
  — parse JSON match events để đếm match chính xác + cắt preview theo byte giữ UTF-8 boundary.
- glob: `rg --files --hidden --no-ignore -g '!.git' <path>` → filter theo semantics pattern
  (không `/` → match basename mọi độ sâu; có `/` → match path tương đối) → `stat` mtime → sort → cap.
- **Binary resolver** (D3): `rg` từ PATH → `<getAgentDir()>/bin/rg` (pi tự download rg cho
  built-in tools vào đây từ lần chạy đầu — tận dụng) → throw error kèm hint cài đặt.
  Không bundle `@vscode/ripgrep` như dsh: pi đã có cơ chế quản binary riêng, tránh double-download
  ~10MB/platform. (Trade-off: máy chưa từng chạy built-in grep và không có rg trên PATH
  sẽ phải tự cài — chấp nhận.)

### 3.4 Spill

Quá cap inline → ghi toàn bộ vào tempfile, trả page inline + dòng
`[Truncated: N of M matches. Full output: /tmp/…/xxx]`. Spill fail **không phải error**
(trả inline + báo không lưu được) — đúng notes dsh. Không làm spill store versioned
(`dsh-spill-local`) ở v1.

### 3.5 Error codes

`SEARCH_INVALID_PATTERN` (regex/glob hỏng — validate trước khi spawn),
`SEARCH_FAILED` (spawn fail/killed/parse hỏng), `SEARCH_RAW_OUTPUT_OVERFLOW` (quá 20MB),
`SEARCH_ABORTED` (timeout/cancel). Map sang throw trong `execute` (pi set `isError`).

## 4. Extension 2 — shell-bg

### 4.1 Hành vi

| Tình huống | Xảy ra gì |
|---|---|
| Command chạy nhanh | Trả như bash thường (exit code, output) |
| Quá `autoBackgroundMs` (default 30s, **chỉ interactive**) | Chuyển nền: trả `moved to background, id=bg-N`, deliver kết quả vào conversation khi xong |
| `background: true` | Detached ngay từ đầu, trả id ngay |
| `timeout: N` | Kill cả process tree khi quá N giây |
| `shell_status` (có/không id) | Status + tail output của 1 job / list tất cả |
| `shell_kill` | Stop job + tree |

Headless (`pi -p`): auto-background TẮT; explicit background vẫn chạy nhưng phải
`shell_status` collect trong cùng turn — message returned nói rõ điều này (pattern pify).

### 4.2 Kiến trúc nội bộ (theo thiết kế pify, viết lại)

- **spawn.ts**: pipe stdout+stderr → tự ghi vào 1 log file append-mode (không dùng inherited fd
  vì Windows không inherit đúng — đo đạc bởi pify); `detached` (POSIX) làm group leader để kill tree;
  `unref` để không giữ event loop; đợi cả 2 pipe `end` + grace timer 150ms sau exit mới settle.
- **registry.ts**: Map trong bộ nhớ = source of truth; mỗi job persist JSON sidecar atomic
  (temp+rename) dưới `os.tmpdir()/pi-shell-bg/<sessionKey>/` — `sessionKey` =
  `PI_SESSION_ID` env (sanitize) → fallback `sha256(cwd)[:16]`. Load lại sau `/reload`:
  job "running" mà pid chết → settle thành finished (dùng `process.kill(pid,0)`, EPERM = còn sống).
- **Delivery**: khi job nền xong → `pi.sendMessage({customType, content, details},
  {deliverAs:"followUp", triggerTurn:true})` đúng 1 lần (`delivered` flag). `/reload` làm
  mất handle → catch, `shell_status` vẫn collect được.
- **bash override**: base trên `createBashToolDefinition(cwd)` + `getShellConfig()` của pi
  (giữ nguyên shell/cwd/env) nhưng thay lifecycle: foreground = race timeout/auto-bg/abort,
  stream tail qua `onUpdate` mỗi 1s.
- **UI**: `/shell-bg` command (list/kill), widget `aboveEditor` hiển thị job đang chạy (tắt khi rỗng).

### 4.3 Settings — ĐÃ CHỐT: 1 file duy nhất, tự scaffold

- Toàn bộ settings của pi-utils nằm trong **một file duy nhất** `~/.pi/agent/pi-utils.json`
  (`getAgentDir()`) — không tách per-extension, không có file per-project.
- **Tự scaffold**: `session_start` thấy file chưa tồn tại → ghi template đầy đủ defaults cho mọi
  extension; file có rồi nhưng thiếu key → merge defaults cho key thiếu, **không ghi đè** giá trị user
  đã sửa. Parse lỗi → dùng defaults + `ctx.ui.notify` warning, không crash.
- Schema v1:

```json
{
  "fsSearch": {
    "noIgnore": true,
    "globMaxResults": 100,
    "grepMaxMatches": 250,
    "grepMaxLineBytes": 2000,
    "rawOutputMaxBytes": 20971520,
    "timeoutMs": 30000,
    "graceMs": 3000
  },
  "shellBg": {
    "autoBackgroundMs": 30000,
    "tailBytes": 8192,
    "killGraceMs": 3000
  }
}
```

- JSON không có comment — fields được document trong README; template chỉ ghi defaults rõ ràng.
- Bỏ layer per-project là chủ ý đơn giản hoá v1; nếu sau này cần, thêm override theo cwd trong
  **cùng file đó** — vẫn không tách file.

## 5. Packaging & phân phối

```jsonc
// package.json
{
  "name": "pi-utils",               // ĐÃ CHỐT (D1)
  "type": "module",
  "peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.74 <1.0" },
  "devDependencies": { "@earendil-works/pi-coding-agent": "^0.78.0", "typebox": "^1.1.24", "typescript": "^5" },
  "pi": { "extensions": ["./extensions/fs-search.ts", "./extensions/shell-bg.ts"] }
}
```

- Dev: `pi -e ./extensions/fs-search.ts` hoặc symlink vào `~/.pi/agent/extensions/` (hot `/reload`).
- ĐÃ CHỐT (D6): repo git **cục bộ** — `git init` + commit, KHÔNG push remote, không publish npm v1.
  Sau này muốn chia sẻ: push GitHub + install qua git URL, hoặc publish npm.
- Zero runtime dependencies ngoài peer (typebox đã là peer pattern của pi-vcc).

Lưu ý: một package = load tất cả entries. Nếu sau này cần bật/tắt từng extension theo user,
tách thành npm workspaces nhiều package con cùng share `src/` — đểphase sau, không làm trước.

## 6. Testing

- **Unit** (`tests/*.test.ts`, bun:test): toàn bộ `src/` vì không import pi — subprocess chạy thật
  trên fixture tree (có hidden/gitignored files), registry persist/reconcile, format/caps, spawn/kill
  cross-platform.
- **Glue**: fake `ExtensionAPI` object (`{ registerTool: capture }`), assert schema + execute wiring
  (pattern pi-vcc tests).
- **Manual**: `pi -e` smoke từng extension trong repo fixture; kiểm widget + delivery trong TUI thật.

## 7. Thứ tự build

1. Scaffold: package.json, tsconfig, biome, bun test, fixture tree trong `tests/fixtures/`.
2. `src/common/` (subprocess, settings, tempfile) + test.
3. fs-search: glob trước (đơn giản hơn) → grep → override wiring + render.
4. shell-bg: src/ thuần trước → extension glue (bash override, status/kill, widget, delivery).
5. README per extension (usage + settings + caps) — làm doc owner cho từng tool.

## 8. Open decisions (chốt trước khi code)

| # | Câu hỏi | Khuyến nghị |
|---|---|---|
| D1 | Tên package + scope | **ĐÃ CHỐT: `pi-utils`** (không scope) |
| D2 | Override `grep` vs tên mới `fs_grep` | **ĐÃ CHỐT: override `grep` + `glob` tên mới, design merged** (mục 3.2) |
| D3 | rg binary: bundle `@vscode/ripgrep` vs resolver PATH→pi binDir | Resolver, không bundle |
| D4 | shell-bg: tự viết theo pattern pify vs phụ thuộc `@pify/shell-background` | **ĐÃ CHỐT: tự viết** (pattern pify, credit MIT trong header) |
| D5 | Có cần spill store versioned như dsh không | Không — tempfile + locator là đủ v1 |
| D6 | Publish npm public hay giữ private/git-install | **ĐÃ CHỐT: git cục bộ, không push/publish v1** |
