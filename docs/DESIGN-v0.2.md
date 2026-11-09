> 存檔設計基線，不是功能完成聲明。實際交付與差異以 `STATUS.md`、`../TEST_REPORT.md` 為準。

# Paseo Session Router — v0.2 產品與架構規格

版本：設計草案 0.2  
日期：2026-10-20  
基線：PASEO_SESSION_ROUTER_SPEC.md（v0.1）  
交付性質：規格與接口草案；不是已部署的 Router、已完成的前端或已驗證的第三方整合。

## 1. 產品定義

建立一個獨立、常駐的 Paseo 多主機控制服務，供 **Grokbot、dot、Muse、CLI，以及後續 Web 管理前端**共用。

使用者描述要做的工作或指定對象；入口理解意圖；Router 找到正確機器、Paseo daemon、工作角色與具體 session，可靠地派工、追蹤、交接與回報。前端以 Tree 查看部署與歸屬，以 Graph 查看協作、任務依賴與交接。

**三個聊天平台是平行入口，不是三套互相同步的控制中心。** Router 也不是另一個會無限制自行分配工作的主 Agent。

所有管理入口使用同一組穩定 ID、同一套權限、同一個排程核心和同一份持久化任務狀態。停用一個入口，不應停止工作，也不應使另一個入口失去任務索引。

## 2. v0.2 相對 v0.1 的變更

1. Muse 列為正式目標入口；API 與 MCP 為並列適配層，不把產品綁死在某一平台或協議。
2. 明確區分 Host、Daemon、Logical Worker、Managed Session、Provider Runtime Session、Task、Turn。
3. 同一邏輯工作角色可關聯多個 sessions；工作線綁定決定續接哪個，而非一律挑最後活躍的 session。
4. 現在定義 topology、關係來源、快照及事件契約；完整 Graph UI 可以後做，但不延後資料模型。
5. Web UI 列為第四個正式控制入口；所有按鈕和聊天工具共用服務端 command handlers。
6. 原有可靠性、精簡 Frontier、單活躍 Controller 與安全限制繼續成立。

## 3. 範圍與非目標

### 必須支持

- 多個已登記主機；同一主機可有多個獨立 Paseo daemon／帳號環境。
- 完整分頁發現 daemon 暴露的可管理 agents，包括按能力設定納入的 background agents。
- 搜尋、精確定位、工作角色別名、工作線續接、排隊、取消、结果與阻塞查詢。
- 結構化跨 session handoff；所有入口可查到同一 task/workstream。
- Tree/Graph 所需的可解釋關係、狀態新鮮度、能力標記、增量更新及管理動作。
- 每個入口獨立認證與撤銷，但按服務端身份映射歸屬同一使用者。

### 不自動承諾

- 接管普通 SSH、tmux、screen 或未被 Paseo 暴露的 provider CLI 對話。
- 承諾讀取或控制 provider 內部、Paseo 未暴露的 subagents。
- 把 session 私有對話、檔案與進程跨主機搬遷。
- 只因 UI 拖動節點便搬移工作；只因連了一條圖邊便執行任務。
- 相同名稱必為同一工作；相似指令必為同一意圖。
- 通過本地去重實現遠端 exactly-once；通過租約過期證明遠端 writer 已停止。
- 讀工具偽裝成寫工具以繞過入口權限限制。
- 一開始建通用 DAG 引擎、向量資料庫、圖資料庫、分散式多活 Controller 或新的 Agent runtime。

## 4. 部署與模組邊界

```text
Grokbot       dot         Muse        CLI       Web Tree / Graph
   |           |            |          |                |
   +-----------+------------+----------+----------------+
                      接入適配層
               Remote MCP / HTTPS API
                            |
                   同一個 Application Core
      Auth ─ Directory ─ Resolve ─ Bindings ─ Task Queue
              Frontier ─ Handoff ─ Reconcile
                     Topology / Events
                            |
                   Paseo Provider Adapter
                 每個 daemon 一個 client
                            |
             SSH tunnel / 已授權的私有連接
                +-----------+-----------+
                |                       |
             Host A                  Host B
          Paseo daemon A          Paseo daemon B
           多個 sessions           多個 sessions
```

Controller 運行在持續在線、可達各主機的機器。第一版為單活躍進程和本地持久化 SQLite；重啟先對帳，不直接重發。

SSH 隧道由服務管理器維護；驗證 host key，不向公網暴露 Paseo daemon。雲端入口到 Router 的 HTTPS 可達性和 Controller 到主機的 SSH 可達性是兩個獨立驗收項目。

手機 QR／Relay 連 Paseo 是獨立的人類入口，不是 Router 的服務憑證。Graph 前端不持有服務器 SSH 私鑰，也不直接向 Paseo 發管理指令。

## 5. 身份模型：不要把三種 Session 混為一談

| 對象 | 定義 | 穩定鍵與規則 |
|---|---|---|
| Host | 一台已登記機器／VM | `host_id`，不使用顯示名稱作主鍵 |
| Daemon | 該機器上某個帳號／配置下的 Paseo 實例 | `daemon_id`；記錄可信身份與 `incarnation` |
| Project | 邏輯項目，可跨機器部署 | `project_id` |
| Workspace | 特定 daemon 中的工作空間 | Router `workspace_id` + native ID；不能把不同 daemon 的同名工作空間視為同一份主本 |
| Checkout / mutation domain | 真正共享檔案寫入的範圍 | `mutation_domain_id`；共享掛載／別名必須映射至同一鎖域 |
| Worker | 使用者認識的長期工作角色，如 `hft/eth-mm` | `worker_id`；`project_id + alias` 唯一 |
| Managed Session | 一個具體、可操作的 Paseo Agent 對象 | `session_ref`；native key 為 `(daemon_id, incarnation, paseo_agent_id)` |
| Provider Runtime Session | Claude/Codex 等 provider 的內部會話標識 | 可空的 metadata；不是 Router 的發送主鍵 |
| Workstream | 一條尚未完成的工作線／Frontier 卡 | `workstream_id`；換 session 不換工作線 |
| Task | 一次持久化指令 | `task_id`；精確目標與提交時的綁定快照不可隨別名漂移 |
| Turn | 遠端一次執行回合 | 來源 daemon/session 下的 `turn_id`；保存真實關聯，不由 idle 推斷 |
| Entry conversation | Dot/Grokbot/Muse 的某個聊天上下文 | 有可信來源時保存；否則用 Router 發出的 `routing_context_id`，不是執行 session |

Paseo 官方 SDK 的 Agent 有穩定 ID，同時另有 `runtimeInfo.sessionId`；Router 中的 Managed Session 對應這個 Agent，而不是憑空在每個 Paseo Agent 下增加可任意切換的原生會話層。[P1]

Worker 是本專案新增的邏輯抽象，可有多個關聯 sessions。常見關係：

```text
Worker: hft/eth-mm
  Session A: gpu1 / daemon-a / paseo-agent-123   ← 工作線 maker-fill 的當前綁定
  Session B: dev2 / daemon-b / paseo-agent-456  ← 另一條驗證工作線
```

只有一個有效候選可自動續接；多個工作線／session 均合理則回傳候選。也允許 session 尚未指派 Worker，在目錄中顯示「未分類」，而不是漏掉它。

`incarnation` 表示已驗證的 daemon 身份世代，不是每次 TCP 重連或每次重啟都加一。真正身份變更或重置才重新登記；身份無法確認時暫停派工。更換 Host 顯示名稱不改 ID。

### 舊版資料遷移

v0.1 的 `(host_id, paseo_agent_id)` 只能在該 host 有唯一且已核實的 daemon 時映射至新鍵。不能猜測同主機的多 daemon 身份。舊 `session_ref` 可保留為明確映射的兼容別名；不能把歷史 task 靜默改指新 session。

## 6. 路由與綁定

解析順序：

```text
精確 session_ref
  → 精確 project/worker alias + workstream 綁定
  → 已驗證 routing context 的既有目標
  → 主機／項目／角色／能力等硬條件
  → title、labels、Frontier 的有限候選排序
```

自然語言理解留給入口 Agent。Router 不新增必需的 LLM 或 Embedding 服務；它提供可解釋候選並執行硬限制。

`resolve_target` 返回候選的機器、daemon、worker、session、工作線、Frontier 摘要、busy 狀態、observed_at、綁定 revision 和 reason。

明確目標忙碌時排隊或拒絕；明確目標離線時報離線；不得靜默選另一個空閒 Agent。未找到合適 session 不自動新建。

解析成功後發出短期 `route_ticket`，綁定 principal/client、精確目標、綁定 revision、mutation domain 和期限。提交和實際派送時再次檢查身份、權限、session 存在性與工作目錄；票據不取代授權。

已入隊 task 固定目標 session。別名之後 rebind，不得使舊 task 自動漂移；需要重新路由時走明確的取消／重新提交／handoff 動作。

### 可跨入口接續，但不靠猜測聊天記憶

同一已驗證使用者在 Dot 派出的 task，可由 Grokbot 或 Muse 用 task ID/workstream ID 查詢。跨平台的同一句話不自動當成同一任務。沒有唯一最近目標時回候選，而不是全局「最後一個 task」策略。

## 7. 多入口適配

| 入口 | 設計接入方式 | 文件能支持的結論 | 實際驗收 |
|---|---|---|---|
| Grokbot | 優先 Remote MCP | 官方列出 Remote HTTPS 及 Command MCP [P3] | 在實際 Bot、帳號及手機入口完成讀／寫／讀結果 |
| dot | 授權的 Plugin/MCP | Dot 共用既有插件權限；自訂 MCP 能力仍受帳號與 workspace 限制 [P4][P5] | 真正的 submit 寫工具，而不只是可列出工具 |
| Muse | 優先 HTTPS API + Custom Connector | Meta 官方支持自訂 Connector，可按外部服務 API 資訊設定 [P6] | 不預設可匯入任意 MCP、OpenAPI 或主動回寫聊天 |
| CLI | HTTPS API | 本專案實作 | 與 MCP 一致的語義、權限與去重 |
| Web | HTTPS API + UI event stream | 本專案實作 | 與 Bot 一致的 command handlers |

此處 Muse 按 Meta 的個人助手入口設計；Muse Code 作為執行 provider 是另一層議題，不混入入口適配。不同 Muse 產品需要替換 adapter，不改 core。

官方 ChatGPT 說明目前仍把 Pro 的 read/fetch 與完整 MCP 寫操作資格分開。因此「產品要求支持 dot」不等於「使用者當前帳號已可派工」。read-only 要明確顯示，不可偷改工具語義。[P5]

各 adapter 記錄 `documented / tested / unavailable / not_tested` 和各項動作能力。未通過無害提交測試的入口不能標為整合完成。

同一套共用 Skill 包括：先查 Router、不猜 ID、續用 workstream、保留未知狀態、按 receipt 說明排隊、重試沿用有效去重鍵、結果附 task/host/session。平台 Skill 只處理入口差異；權限與排隊不能只靠 Skill。

## 8. 統一對外接口

下列名稱均為本專案接口，不是 Paseo 原生命令。

### 查詢

- `psr_list_hosts`：主機、daemon、連線與能力。
- `psr_list_sessions`：跨 daemon 分頁查詢、按 project/worker/workstream 搜尋。
- `psr_resolve_target`：候選、路由原因、綁定版本與短期票據；不派工。
- `psr_get_session`：來源身份、狀態、有限活動及可用動作。
- `psr_get_task`：任務狀態、所屬 turn、Frontier 與有限結果。
- `psr_get_topology`：Tree/Graph 的標準節點及關係投影。
- `psr_read_updates`：有限變更、游標與 gap。

### 寫入

- `psr_submit_task`：以精確票據、prompt、去重鍵和 busy_policy 建單。
- `psr_ack_updates`：確認指定 consumer 已處理更新，不代表平台一定已送到人。
- `psr_bind_worker`：指定工作角色／工作線與 session 的綁定；expected_revision 必填。
- `psr_set_dispatch_mode`：`managed / paused / observe_only`；暂停派工不等於取消在途任務。
- `psr_cancel_task`：排隊取消或已驗證的 turn 取消，不等於永久 kill。
- `psr_create_session`：只接受預配置主機、項目、provider 和隔離政策。
- `psr_handoff`：建立後續工作包、產物引用及明確的依賴／交接關係。

生命周期管理等較高風險動作另設 scope。Paseo archive 可能具有原生子 agent 級聯效果；第一版不放在普通「取消」按鈕下，未驗證影響範圍就禁用。[P1]

### HTTP 對應

```text
GET    /v1/hosts
GET    /v1/sessions
GET    /v1/sessions/{session_ref}
POST   /v1/resolve-target
POST   /v1/tasks
GET    /v1/tasks/{task_id}
POST   /v1/tasks/{task_id}/cancel
POST   /v1/workers/{worker_id}/binding
POST   /v1/workers/{worker_id}/dispatch-mode
POST   /v1/handoffs
GET    /v1/topology
GET    /v1/events?after={cursor}
```

精確 schema 以契約與驗證器為準。MCP、HTTP 和 CLI 共用驗證、Core 和儲存，不是三套實作。GET 不執行派工等副作用。

## 9. 任務可靠性

繼承 v0.1 的安全派送模型：

```text
queued → sending → accepted → running → completed
            |                   ├→ waiting_permission
            └→ delivery_unknown ├→ failed
                                └→ cancel_requested → canceled
```

主機連線、新鮮度、執行狀態、驗證結果、通知結果分開保存。`completed` 只表示對應回合已結束並收集結果，不代表測試通過。

1. 在 SQLite 交易中保存指令與派送意圖，立即回 task receipt。
2. 排程取得 mutation-domain 的單 writer 執行權；網路等待不得持有長交易。
3. 重讀 session、綁定、活動 turn、工作目錄和 Frontier ownership。
4. 在送出前建立並等候 timeline observation ready，保存 cursor 及 dispatch attempt。
5. 送出帶唯一 task 標記的指令；按真实接受結果及 turn correlation 更新。
6. 觀察 terminal event；保存有限摘要、證據引用與驗證狀態。
7. 確認寫入者／外部 jobs 已交還工作權才放行下一個 writer。

相同有效去重鍵、相同 payload 回原 receipt；不同 payload 回 conflict。跨入口語義相似只提示，不自動合併。

send 後斷線或派送前後崩潰產生不確定性時，以 `delivery_unknown` 對帳；搜尋實際 user event、task 標記及 turn，不靠 assistant 的文字自述，也不盲目重發。不能可靠歸屬時保持未知。

Router 本地停止等待或 lease 過期不能證明遠端停工。取消要求只有取得相應證據才標 canceled。Provider 權限待辦預設交由人處理；不自動 allow-all。

Paseo SDK 文件明確區分 `send` 與 turn 完成，也說明 timeout 不取消 agent。Timeline 重連不自動補歷史；需按 epoch/seq 補讀去重；不能由 idle 狀態推斷 turn 完成。[P1][P2]

## 10. 工作目錄衝突與人工接管

不同 sessions 仍可能共用同一 checkout，所以鎖域不是 agent ID。跨 host 的共享儲存、符號連結和同一檔案的多個掛載點，要用已核實的共同 `mutation_domain_id`，不能只靠路徑字串。

無法判定寫入邊界時，使用獨立 checkout/worktree，或阻塞並要求管理員設定；不假裝有隔離。

`managed` session 由 Router 派工。Paseo App 可監看和處理已核實權限待辦；手動發新指令前先將角色設為 `paused`，處理在途任務，完成交接。暫停只阻止後續派送。

Router 的鎖不約束繞過它的 App/CLI。偵測外部 turn 時暫停後續派工並顯示 out-of-band activity；在沒有 daemon 原子條件提交的情況下，不能保證完全消除競態。

Web 管理動作不走直達 Paseo 的捷徑，否則 UI 本身也會成為 bypass。

## 11. Tree 與 Graph：兩種投影，一份資料

### Tree：回答「在哪裡、誰在做、現在怎樣」

預設機器視角：

```text
Controller
  gpu1
    daemon-research
      workspace-hft
        eth-mm             [Worker 群組]
          session-A        [Paseo managed session]
            task-42        [running]
        queue-model
          session-B        [waiting_permission]
        未分類
          session-C        [idle]
  dev2
    daemon-dev
      workspace-router
        backend
          session-D        [running]
```

可切換項目視角：`Project → Worker → Sessions（附 Host）→ Current Tasks`。Worker 是群組，不是另一個遠端進程。多個視角中的同一 session 使用同一 canonical ID。

### Graph：回答「誰依賴谁、工作怎樣流轉」

只顯示有來源的 typed edges：

- Host → Daemon：部署關係。
- Daemon → Session：原生目錄暴露。
- Worker → Session：明確的角色／工作線綁定。
- Client → Task：由已驗證入口身份提交。
- Task → Session：本次指令的固定目標。
- Task → Task：明確依賴或 handoff。
- Session → Session：Paseo 真實 native parent 關係，只有 adapter 可核實時才顯示。

圖邊不从模糊聊天內容推斷。Native parentage、Router 的任務依賴、Worker 綁定分為不同 edge type；不要把三者都叫「子 Agent」。

Paseo 文件已有 parent 建立子 agent 的能力，能驗證的原生親子關係可以匯入；無 metadata 時顯示獨立節點，不自行還原內部結構。[P1]

依賴邊與 handoff 都引用具體 tasks。同一 Worker 間可能有多輪往返，但 task 依賴不能循環；handoff 有深度和總量限制。

### 圖形管理的操作語義

拖動只保存視圖座標，不迁移 session。畫邊預設關閉；未來啟用也只生成一個經權限檢查的明確管理請求。布局位置、折疊、篩選與固定節點不改執行狀態。

第一版前端首先提供搜尋、Tree、session 詳情和任務抽屜；再加入 Graph。Graph 預設只看選定項目及 active/blocked tasks，避免把所有短期歷史和每個 token 畫成節點。

### 每個節點的共同顯示欄位

`id / kind / label / observed_at / freshness / version / status / allowed_actions`，必要時附 `host_label / worker_alias / provider / cwd / current_task / frontier_current / reason`。

`host offline + last_observed running` 顯示為「離線，最後觀察為執行中」，不是綠色 running，也不是 failed。Busy、permission、delivery_unknown 與 stale 均使用文字/圖示，不只依賴顏色。

`allowed_actions` 根據當前已驗證 principal、Router policy 和 daemon capability 產生；前端不是授權邊界，按鈕點下時再次驗證。

UI 可顯示已核實的 Paseo deep link；無可靠链接則提供 Host/session ID，不杜撰可點擊 URL。

## 12. Topology 查詢與實時事件

拓撲由標準資料表投影，不需要把任意 nodes/edges 當第二份可獨立修改的主庫。

`GET /v1/topology` 接受 project/host/workstream/root_node、視角、頁量與展開深度。預設只載入有限圖；返回 `nodes`、`edges`、`snapshot_version`、`stream_cursor`、`has_more` 和 pagination 信息。

快照對 Controller 的已觀察狀態一致，不承諾各遠端同一毫秒的全局快照；各 host/session 都保留 `observed_at`。分頁需固定快照 token 或明確要求重取，不能把多個版本混成完整圖。

### 事件流流程

1. 在同一資料庫一致性邊界取得 topology 快照和 event watermark S。
2. 前端訂阅 watermark 之後的已授權事件。
3. 事件包含 `seq`、`entity_id`、`entity_version`、`kind`、有限 payload。
4. 以 ID 和 version 合併，忽略重播／舊版本；刪除使用保留窗口內 tombstone。
5. 斷線重連從 cursor 續讀；窗口外回 `RESYNC_REQUIRED`，重新取快照。

資料變更和短期 outbox 事件同一 SQLite 交易提交。seq 在重啟後不重置；它只表示 Controller 事件順序，不代表所有遠端的真實物理先後。

事件按 principal/project 過濾，連邊和計數也不能洩漏未授權節點。cursor 與查詢範圍/權限版本綁定；權限撤銷、查詢範圍變更時使舊 cursor 失效。

Web UI 可採用 SSE 作單向狀態傳輸，寫操作仍用 HTTPS POST。這是 UI 事件通道，不是自行發明一套 MCP transport。認證使用安全 session cookie 或支援 Authorization header 的串流客戶端，不把 bearer token 放 URL。

不永久鏡像 Paseo 原始 timeline，只傳 directory、任務和有限 Frontier 更新。原始日誌按需從 Paseo 讀取。

## 13. 前端技術選型

建議 React + TypeScript；Graph 使用 React Flow 自訂 nodes/edges，布局先用可替換 adapter，複雜多層图再接 ELK。React Flow 官方提供節點/邊的互動能力及布局整合說明；它不取代我們的狀態、權限與排程服務。[P7][P8]

不為了畫圖引入 Neo4j 或完整工作流引擎。關係數和運維規模真的需要時再改儲存層。

前端初期可作為單一 Web app 的 Tree/Graph 兩個頁面。手機優先 Tree + 搜尋 + 詳情，Graph 保留縮放、選中子圖與「列出關係」替代視圖；不用全屏密集圖作手機唯一入口。

## 14. Frontier：維持當前工作，不重建聊天歷史

沿用已約定的 worklog/Frontier：每 workspace 最多 16 張當前卡、每卡最多 4 KiB、整个 workspace 最多 3 個關鍵歷史節點；主本總容量遵守既有 32 KiB 限制。不是每個 session 各保留三個歷史。

Frontier 綁定 workstream，角色換綁或 session 更換仍更新原卡。保存 current、next、blockers、owner、refs、revision。已完成的卡依既有 finish 規則刪除，不新增永久 session 檔案。

現有 worklog 是主本時，Router 只持有 adapter 和可重建快取，不維護第二份可獨立寫的 Frontier。版本衝突必須重讀合併。

不同 host 上的同名 repository/workspace 不自動共享主本；需要明確指定 authoritative Frontier store。未配置跨主機主本時，用帶來源及 revision 的 handoff 摘要，而非雙向偷偷合併文件。

Graph 展示當前 Frontier 關係，不用 token 或所有歷史事件充當節點。

## 15. Handoff 與產物

跨 session 通信採結構化工作包：objective、source_task、target_ticket、context_summary、artifact_refs、acceptance_criteria、workstream、預算／深度上限。

接班者先讀工作卡和實際產物，再決定執行，不把來源 Agent 的自述當驗證結果。跨機器檔案引用必須真正可讀：可達的產物存儲、Git 提交或明確授權的傳輸。A 主機的 `/tmp/result.csv` 不會因為發了一條訊息就出現在 B。

handoff 不等於把 provider 的私有 context 搬走。需要轉換 provider 時，是在目標 session 讀取有界工作包後接續，不宣稱無損遷移完整對話。

交接先確認原 mutation domain 的 writer 已停止或已隔離，再轉交 ownership。外部 jobs 未結束時不以 session turn 結束代替工作權釋放。

## 16. 通知和多入口共同管理

核心支援 shared task registry，但通知 sink 按入口能力獨立啟用。

第一版保底：提交立即回 receipt；之後用 get_task/read_updates 查詢。可用平台通知、routine 或 webhook 要另驗證和明確授權，不承諾任意 MCP 客戶端都可以讓 Router 主動寫回原聊天。

每個 client/sink 有獨立 cursor 和認證。Dot 消費更新不會把 Grokbot/Muse 的游標一起前移。全局 inbox 可展示已處理狀態，但不能藉此偽造另一入口的通知成功。

`execution_completed`、`verification_passed`、`notification_delivered` 分開。撤銷一個入口只停止其存取與通知，既有 tasks 依既定策略繼續；要取消工作需要另一次明確操作。

## 17. 儲存、上限與身份安全

建議標準表：hosts、daemons、projects、workspaces、workers、sessions、route_bindings、tasks、dispatch_attempts、task_dependencies、handoffs、mutation_locks、frontier_cache、updates_outbox、consumer_offsets、client_registrations、view_preferences。

Topology 為這些表的投影；session 執行事實以 Paseo 為主本，task 意圖與 route binding 以 Router 為主本。

起始建議上限（本專案預設，不是 Paseo 預設）：

| 資料 | 保留／配額 |
|---|---|
| active + queued tasks | 64；滿額回壓，不刪未完成工作 |
| terminal task receipts | 最多 200、最長 7 天、摘要每條 8 KiB |
| outbox | 最多 10,000 條、最長 24 小時、单條有限 payload；窗口外強制重同步 |
| dispatch attempts / active dependencies | 有單任務上限；不確定派送不無限重試 |
| route tickets / 去重 | 有效期明確，GC 後陳年重放拒絕，不當新指令 |
| graph response | 預設最多 200 nodes、500 edges，較大圖分頁或限定子圖 |
| view preferences | 每使用者有限份數與大小，不保留無限布局版本 |
| Frontier | 既有卡數、字節和 3 節點限制 |
| logs | 大小輪轉；禁止全量 token/secret 鏡像 |

未完成或仍被活動依賴引用的有限任務不得因 terminal receipt 清理而變成斷鏈；保留必要有限 metadata，依賴圖上限用回壓維持，不能偷偷製造 dangling edges。游標、墓碑及身份變更記錄也有窗口與重同步規則。

已登記資源和仍存在的 sessions 可保留必要索引，但註冊有配額，遠端已刪除 session 的短期墓碑和失效 bindings 需整理。Router GC 不等於清除 Paseo 的歷史。

最少區分 read、submit、create、cancel、bind、handoff、admin scopes，加上 project/host/mutation-domain 約束。Origin/client 是從服務端驗證凭證導出；prompt 裡寫 `source=dot` 或「我是管理員」沒有授權效力。

任務輸出、repository 文件、Graph label 都是不可信內容。前端轉義顯示；不允許輸出更改工具權限、任意 SSH 目標或任意 callback URL。

## 18. 建議程式結構

```text
apps/
  router/                 # 常駐服務、HTTP/MCP entrypoints
  cli/                    # 呼叫同一 HTTP API
  web/                    # 後續 Tree / Graph / detail panels
packages/
  contracts/              # schema、ID、錯誤、事件、API DTO
  core/                   # resolve、submit、bind、handoff、reconcile
  store/                  # SQLite、migrations、bounded outbox、GC
  paseo-adapter/          # 真實 SDK、native identity、capability probes
  frontier-adapter/       # 既有 worklog 主本與版本控制
  topology/               # typed relations、tree/graph projection
  entry-adapters/         # Grokbot、dot、Muse 接入差異
skills/
  session-control.md
  grokbot.md
  dot.md
  muse.md
tests/
  unit/
  contract/
  integration/
  fault-injection/
  ui/
```

這是模組邊界，不要求第一天把所有目录做成獨立 npm 套件。Node/SDK/daemon 和前端依賴固定在實際通過測試的版本。

## 19. 分階段實作

### A. 接入與身份探測

測試主機建立 read、無害 submit、result、reconnect 合約；核實 native Agent/runtime ID、分頁和 background 可見性。三個外部入口分別跑讀／寫／讀結果，記錄「實測通過」或明確阻塞，不能用其中一個入口成功代替全部。

### B. Headless 核心閉環

多 host/daemon directory、workstream binding、resolve/submit、單 writer queue、unknown 對帳、有限結果與 Frontier、共用 MCP/API/CLI。一次指令從任意已授權入口派出後，可從其他入口查同一 task。

### C. 可視化管理的垂直切片

同一份 live data 上做 Tree、搜尋、session detail、current task、pause dispatch、受控 submit/cancel。先有實際可用的最小 Web 管理頁，不必等完整 Graph。

### D. Graph 與協作

typed relations、關係來源、依賴/交接子圖、原生 parent 匯入、節點管理操作、有限事件恢复与通知能力矩陣。這一步不改核心 ID 和 task API。

## 20. 驗收標準

1. 至少三個已登記測試 hosts、多個 sessions，同名 agent 不串線；同主機兩個 daemon 不碰撞。
2. 完整分頁和 background agents 均能呈現；受權限或過濾影響的結果明示范围。
3. 一個 Worker 有多個 sessions；有 workstream 綁定時續接正確者，無唯一目標時回候選。
4. Grokbot 派工、dot 查詢、Muse 經授權查詢／取消，全部操作同一 task；任何入口未具備寫權限明確失敗。
5. 三個入口及 Web 同時派工到同 mutation domain，不产生兩個 Router writer。
6. rebind 後舊 task 仍固定原 session；過期 route ticket 和 binding revision 被拒絕。
7. send 後斷線或記錄前崩潰只對帳，不重複執行；身份 mismatch 不自動連到另一 daemon。
8. Tree 與 Graph 同一實體使用同一 ID；顯示相同工作狀態与時間戳。
9. Host offline 保留 last-observed state 並顯示 stale；不把 offline 誤報 task failed。
10. Graph 每條關係有明確來源；未知 subagent 不編造，native parent 和 task dependency 不混用。
11. 拉取快照期間發生更新，隨後訂閱無缺漏；亂序／重複事件不回退新版本。
12. 事件游標過期強制重同步；權限撤銷不能靠舊 cursor 繼續讀資料。
13. 拖動圖節點不移機、不換 session；連線不自動執行指令。
14. 暫停派工不等於取消在途 task；cancel 與永久終止、archive 嚴格區分。
15. 直接 Paseo 操作引發 out-of-band 提示與派工暫停；不宣稱本地鎖能阻止直接外部寫入。
16. Frontier 在換入口／換 session 後仍續用原工作卡；revision 衝突和容量限制有效。
17. 跨機器 handoff 產物真的可讀，mutation ownership 交接有依據；不把路徑文字當檔案傳輸。
18. 長期模擬後 outbox、receipts、logs、view preferences 和歷史节点均在上限內，活動依賴不斷鏈。
19. 執行、驗證、通知各有獨立證據；讀取不等於已告知使用者。
20. 三個聊天入口與 Web 的管理指令使用同一 Core；UI 不持有直達 Paseo 的管理憑證。

## 21. 本次核對的官方來源

來源日期：2026-10-20。以下是文件依據，不是本專案在使用者環境的測試結果。未引注的設計要求為本專案方案，不是產品既有功能宣稱。

- [P1] Paseo Agents SDK：https://paseo.sh/docs/sdk/agents
- [P2] Paseo SDK events：https://paseo.sh/docs/sdk/events
- [P3] Grok Bot Team Bots，自訂 MCP 表：https://docs.x.ai/grok-bot/team-bots
- [P4] Dot 插件權限：https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs
- [P5] ChatGPT 自訂 MCP 與帳號/動作資格：https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- [P6] Meta Muse Connectors / Custom connectors：https://www.meta.com/help/artificial-intelligence/1687253048996149/
- [P7] React Flow：https://reactflow.dev/learn
- [P8] React Flow layout integration：https://reactflow.dev/learn/layouting/layouting

前一版提供的更細 Paseo 連線、部署及 SDK 方法，在真正實作時仍需依固定版本再做 contract test。不要僅從本規格複製尚未在目標版本驗證的取消、深鏈、子代理或權限方法。
