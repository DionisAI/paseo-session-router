# Paseo Session Router 0.3.0

[English](README.md) · [安全說明](SECURITY.md) · 非官方專案，與 Paseo 無關；要連的機器上需要先執行 Paseo。

**一個常駐控制服務，讓 Grokbot、dot、Muse、CLI 和網頁總控臺，共用多機器 Paseo Session 的目錄、任務與結果。**

這是可運行的 MVP，不是只有規格。包含 TypeScript 原始碼、測試、Web 前端、API／MCP 工具契約和部署範例；release 壓縮檔另附已編譯程式（`dist/`）。核心和示範模式沒有 npm runtime dependencies。

**驗證邊界：本地核心、HTTP／MCP／CLI、SQLite 恢復、模擬多 daemon 與瀏覽器介面有自動測試；線上已接 6 台真機（經 Paseo relay），派工、排隊、審批、取消、服務呼叫、論壇、本機 session 訊息、共用資源和檔案轉送都在真機上試點過。三個平台本身（Grok VM 的 `psr` 命令、dot、Muse 帳號）尚未從頭到尾驗收，也還沒有哪台機器真的重開機驗證過自動啟動。** 逐項狀態和已知限制見 `docs/STATUS.md`。真實 SDK 適配器是獨立可替換模組，不能把它的結構測試當成實機通過。

## 1. 先啟動可操作版本

需要 Node.js **22.16.0 或更新版本**。此版本已在 Node 22.16.0 測試；使用內建 SQLite。

```bash
cd paseo-session-router
npm run install:dev && npm run build   # 從 git clone 下來時；release 壓縮檔已含 dist/
npm run demo
```

不需要其他 `npm install`。終端會顯示本機網址和當次產生的 console token。開啟顯示的網址，貼入 token。預設網址：

```text
http://127.0.0.1:8787
```

Demo 有三台模擬主機、四個 daemon、五個 Session；同一 native Agent ID 可以出現在不同 daemon，Router 不會串線。初始研究／回測 handoff 是**模擬工作**，不呼叫模型、不執行 shell、不連交易系統。介面上明確顯示 SIMULATED ENVIRONMENT。

登入後預設是**總控臺**（3D 總覽），畫風參照星露谷物語：每台機器是一塊圍著籬笆的農場，每個 session 是農場上的小屋（Claude 是赤陶色屋頂，Codex 是紫色屋頂），agent 站在門口，正在做事的小屋煙囪冒煙，等你批准的頭上冒出「!」；中央廣場的市政廳是 Router，門口的布告欄釘著還沒完成的目標（黃色紙條是方案待批）；入口（Muse、Grokbot、網頁…）是前方的木門。總覽只標出機器、入口，以及正在運行、需要留意或出錯的 session；拉近、滑過一塊農場或點選時才顯示其餘 session 的名稱，細節在滑過的提示和右側面板。進行中的任務是傳送帶上的木箱，排隊的任務堆在農場的入口，完成或中途消息會飛回來源；天色、天氣和季節跟著設定的地點（見下文）。管理員點左側列表每台機器右邊的 ✎（session 的 ✎ 在滑過時出現），或右側面板名字旁的「✎ 改名」，就地改名，Enter 儲存、Esc 取消，留空恢復配置名；說明、標籤和規則在面板下方的表單裡改（都經 `psr_annotate`，Muse 規劃時會先讀）。底部工具列：全景、左右轉、拉近拉遠、名牌、像素、任務、展示。

左上角的切換是同一個 3D 世界裡的四個鏡頭位置，切換時鏡頭飛過去，不會跳成平面頁面；左邊的清單面板和右側面板在各個視角裡都一樣：

- **總覽**：整個世界——機器公園和任務花園。
- **機器**：鏡頭飛到機器公園。左邊面板是機器卡片和它們的 session（模型、目錄、最近一個任務），可搜尋、按狀態篩選。每張機器卡片有 CPU、記憶體、磁碟三條量表（要裝機器狀態回報程式），點開機器看每個磁碟的明細。點 session 後在右側面板直接**派任務**（忙時排隊，不打斷正在跑的一輪）、暫停／恢復後續派工、看最近任務和中途消息、讀寫工作區筆記（Frontier）、改名和寫說明。
- **任務**：鏡頭飛到任務花園。**一株植物是一個任務（mission）**——使用者交給大腦的一個目標，可能跨多台機器、多個 session；一個子任務（例如「盤點」「升級」）是一根主枝，主枝上每一步一根小枝；沒有子任務時，每一條交接／回覆鏈是一根枝。枝頭顯示這一步的狀態：發光的綠芽是運行中，琥珀色燈籠是等你（審批或對帳），灰色花苞是排隊，開花是完成（花色＝誰派的），下垂的褐色枝頭是失敗。前排是需要你的任務（含未處理的失敗），中排是進行中和排隊，後排是 24 小時內完成的；更早完成的移進後面的**溫室**，點溫室或清單的「歷史」篩選隨時查看。任務的整體狀態取最緊急的一步：需要你 → 進行中 → 排隊 → 未處理的失敗 → 完成（失敗後重試成功記為「重試後完成」）。session 和機器不是花園裡的物件，只出現在每一步的說明裡（例如「等同一個 session 的上一個任務」「GPU · Research · eth-mm」）。左邊的清單是一棵樹：任務 → 子任務 → 步驟 → 交接／回覆；點植物或清單項，右側面板顯示任務名稱（可改名）、進度條、等你批准的請求和每一步在做什麼；點一步看完整指令、結果、中途消息、審批記錄，並可取消排隊中的步驟、回覆、交接，或（管理員）釋放寫入鎖。「完成」只代表 turn 結束，面板會標明是否已驗證。

- **權限**：鏡頭飛到中央的 Router。這裡設定規劃者（用哪個 Claude 模板建立、多久喚醒一次、每小時最多幾次、啟用或停用）、**每個權限等級由誰批准**、**自動批准**（哪些請求不用等人）、等級規則（內建規則可開關，可以加自己的規則，還能試判一條命令）、以及每個前臺（Muse、Grokbot、dot）的**權限上限**。

**即時動態。** 每個任務是一個木箱：新任務從入口沿傳送帶經中央 Router 送到那台機器，停在負責的 session 前面直到做完。session 正在做事時，頭上浮出一張即時卡片：最近幾步（跑了什麼命令、讀或改了哪個檔案，命令裡像金鑰的部分會被遮住）、它剛說的話、等審批時的確切命令和「批准這一次／拒絕」，做完時顯示結果。新任務、等你批、完成、卡住、新目標和方案待批會在發生的地方跳出漫畫式的提示。點一個木箱，鏡頭就跟著它走（拖動、捲動或按 Esc 結束）。底部「展示」切到展示模式：收起所有面板，只留進行中的數量和時鐘，鏡頭在正在做事的 agent、全景和任務花園之間慢慢巡航，有新事件就飛過去；網址加上 `#showcase` 打開即進入展示模式，適合放在副螢幕上。

**天色、天氣和季節。** 時鐘、日出日落和季節跟著設定檔 `weather` 指定的地點（`name`、`timezone`，要天氣再加 `latitude`、`longitude`；南半球季節自動倒過來）。有座標時，天氣由 Router 向 Open-Meteo 取即時天氣，最多每 10 分鐘一次（`GET /v1/weather`，要登入，大家看到同一片天）；只有時區時只跟時間和季節，不連外；沒設 `weather`（預設，demo 也是）時 Router 完全不連外，總控臺用瀏覽器自己的時間，不顯示天氣。設定方式見 `docs/DEPLOYMENT.md` 的 Console weather。陰天變暗，下雨下雪有雨絲和雪花，下雪時地面和樹變白，雷雨會打閃，起霧時遠處朦朧；春天櫻花和花瓣，秋天紅葉、落葉和蘑菇，冬天樹葉掉光，夏夜有螢火蟲；入夜後燈籠和窗戶亮起。拿不到天氣時只是沒有天氣，時間照走。底部「像素」切換像素畫風和平滑 3D，只記在這台瀏覽器。想預覽別的天色，網址加 `?sky=rain`（clear、cloudy、overcast、fog、drizzle、rain、snow、storm）、`?hour=21`、`?season=winter`，可以組合。

**規劃者（Router 的大腦）。** Router 用一個 Claude 模板建立自己的規劃 session（規劃者經本機網址連回 Router，所以只要有 daemon 的 http agentChannel 是這個網址，就只能選那些 daemon 上的模板）：給它規劃者指令、透過 MCP 只給 Router 的工具（附一張只對這個 session 有效的憑證），並關掉 Claude 內建的 shell、檔案和網頁工具。Muse、Grokbot、dot 和總控臺是前臺：用 `psr_submit_goal` 把使用者的原話交給它，規劃者拆解、派工、回報；它的提問和方案透過前臺的收件匣（`psr_inbox`，帶 `goalId`）原樣傳給使用者，前臺用 `psr_goal_reply` 回答、`psr_decide_plan` 批准或退回方案。Router 只在有事時喚醒它（新目標、回覆、方案決定、步驟結果、權限請求、session 的消息），同一時間最多一輪、按喚醒間隔合併、每小時有上限；規劃者讀 `psr_planner_inbox`，處理完用 `ack` 確認。每個目標就是一個任務（mission），在花園裡是一株植物，沒有步驟時是幼苗。規劃者送出的每一步都必須屬於一個未結束的目標；在方案批准前，它只能批准這個目標的 L0（只讀）請求。換一個新的規劃者後，舊的憑證立即失效。

**獨立驗收。** 任務做完不等於做對。規劃者（或你）派任務時可以帶 `verify = {arbiterId, criteria}`：一到八條在機器上查得到的標準，例如「node -v 印出 v22.20.0」。任務完成後，Router 先跑設定檔裡的機械驗證器（如果有），再派一輪給**驗收 session**：一個你建立、只有 Router 能派工的獨立 session，必須在任務所在的那台機器上（別的機器看不到它的檔案，所以不會轉過去）。它只能讀那個任務自己目錄裡的檔案、對那裡跑唯讀命令，以及設定檔列出的確切命令，其他請求 Router 在代碼裡直接拒絕（只認寫出來的路徑：目錄裡指向外面的符號連結攔不住；機器用戶自己的 `~/.claude` 設定裡預先放行的工具也不經過 Router，建驗收 session 前要先看過）。任務的目錄不能是 `/`、頂層目錄或整個家目錄（座位模板自己的目錄也不行：座位用不帶路徑的檔名讀它）。判決存下前會盡量遮掉看起來像密鑰的內容，但這只是盡力而為；工人的報告放在最後，標成未經證實的說法。它用 `psr_verdict` 逐條給出判斷和證據，判決必須引用那一輪的一次性 nonce，每條標準都要有 40–500 bytes 的證據。結果寫進任務的驗收欄（通過、未通過、沒有結果），並標出「只有仲裁者判斷」「和幹活的同一家模型」這類限制；規劃者收到 `task_verified`。驗收 session 自己那一輪只有你和規劃者看得到。設定檔在 `psr_set_policy` 的 `verification.profiles`；驗收 session 用帶 `seat: true` 的模板，以 `psr_create_session`（`role: arbiter`、`profileId`）建立，只有你能建。可選的關卡 `requireForGoalDone`：還在驗收的目標不能結案（失敗的任務和沒有結果的驗收不會擋住）。

**服務呼叫。** 一個 agent 可以像呼叫工具一樣用另一個 agent：`psr_ask` 把請求交給一個**服務**（例如「data：資料機上哪個檔案有什麼欄位、怎麼讀」），通常在同一次呼叫裡就拿到回答。它是同步的「agent 當工具」；幾個 agent 分頭做同一個任務的不同部分時，用論壇協作（見下），不走 `psr_ask`。回答的是**服務 session**：用帶 `seat: true` 的模板，以 `psr_create_session`（`role: service`、`service`）建立，只有你能建，也只有 Router 派工給它；每個模板只能有一個在用的服務 session（同一模板的 session 共用一個目錄和 mutation domain，只能輪流跑），同一服務要多個 session 就各用自己的模板；它忙的時候請求在服務的佇列裡按順序等，Router 不打斷正在跑的一輪。呼叫方必須正在跑 Router 派的一輪，所在 daemon 的 `agentChannel` 要是 `http`（observed 通道帶不回同步的回答），而且要在那之後建立。等多久：Claude 最多等到服務的 `waitSec`（預設 600 秒），Codex 最多 270 秒（它的工具呼叫 300 秒就硬性斷開）；等不到時（超過時限、連線斷了、Router 重啟或關機），呼叫先回 `queued`（這是正常結果，不是錯誤；呼叫被取消或呼叫方那一輪已經結束時則不回結果），回答放進呼叫方的佇列，等那個 session 空下來（沒有在跑或排隊的任務），用一個「[Router] 服務回覆」任務把待送的回答一次送到，成為它的下一輪。佇列都有上限：每個服務最多 `queueMax` 個請求在等（滿了當場告訴呼叫方）；每個請求的期限是 `ttlMin`（預設 60 分鐘），到期時排隊的作廢、在跑的那一輪被取消，沒送出的回答也只留這麼久；同一服務、同一 `topic` 的新回答取代還沒送到的舊回答，每個呼叫方最多留 `deliveryMax` 個（預設 5）；呼叫鏈最多三層、不能繞回，一輪最多三次，每個 session 每小時二十次。有哪些服務、哪些機器能呼叫、服務還能再呼叫誰、Router 自己代批到哪一級、可讀的目錄和確切命令、佇列上限、期限和等待時間，都在「權限」頁的服務呼叫卡片裡改（`psr_set_policy` 的 `a2a`），那裡也顯示佇列長度、可以清空；設定檔只定義機器和模板。服務那一輪的權限請求由 Router 依 `autoAllow` 在代碼裡回答：`none` 全部留給你，`L0` 放行讀服務自己的目錄和你列的目錄（讀命令要是單條純讀命令：不串接、不用管道、重定向和萬用字元，服務 session 的提示裡寫明了規則）、在它自己的目錄裡跑你列的確切命令，`L1` 再加改它自己目錄裡的檔案（它自己的 agent 和 git 設定除外：`.claude/`、`.codex/`、`.git/`、`.mcp.json`、`CLAUDE.md`、`AGENTS.md`）；憑證和金鑰一律拒絕（命令所在的目錄名像憑證也算，換成看起來不同、在不分大小寫的 macOS 上指向同一個檔案的寫法也算），被 Paseo 截斷的請求看不全，也留給你，其他的**只有你能批**（規劃者和前臺都不能，`psr_list_permissions` 顯示「只有你能批（服務輪）」）。服務 session 不能建在只接受你回答的機器（`humanApproval: true`）上；那種機器上的 session 只有在會先詢問的模式（`default`、`plan`）下才能呼叫服務，排隊的回答也只在它處於這種模式時才送過去。服務只在最後一則訊息裡回答，不另存檔案；主機規則裡指定的產出位置是給那台機器上幹活的 session 用的，不適用於服務的回答，其他主機規則照樣約束它。回答是另一個 agent 的輸出，只是資料，不能授權任何事；服務那一輪只有你和規劃者看得到，`psr_list_asks` 列出誰問了什麼、走到哪一步、回答和送達情況。部署步驟見 `docs/DEPLOYMENT.md`。

**Agent 之間只有兩種溝通**（這裡指 Router 派活的 Paseo session；你手動開的本機 session 另有點名消息，見下表「本機 session」）。一種是點對點請求：`psr_ask`（上面的服務呼叫），一個 agent 問一個服務、等它回答。另一種是**論壇**：每個帶 `missionId` 的任務有一個共用的論壇（規劃者派的任務就是目標 id），不用建立、沒有成員也沒有角色。正在為這個任務跑 Router 派的一輪的 session 用 `psr_forum_read` 讀、用 `psr_forum_post` 留言（發現了什麼、接手了什麼、做完了什麼、結果放在哪）；規劃者可以讀寫所有未結束目標的論壇；你在總控臺任務面板的「論壇」裡看，也可以用你的身份貼文。只拉不推：貼文不會叫醒任何人、不產生新的一輪，agent 只在自己那一輪裡讀；每一輪的提示後面會多一行「[Router] 論壇 · mission … · N posts」告訴它論壇上有幾則。上限：每則 2000 bytes，每個論壇留最近 200 則，每個 session（和規劃者）每小時 20 則，一次最多讀 100 則；像金鑰的內容（`NAME=值`、32 字元以上的不透明字串）存的時候就遮掉。貼文是別人寫的資料，不是指令，不能授權任何事。只有 `http` agentChannel、在這一版之後建立的 session 才有（工具在建立時預先批准，舊的 session 要重建）；服務和驗收 session 沒有；只接受你回答的機器上的 session 只在 `default`、`plan` 模式下能用。規劃者要重建一次（第 5 版）。部署步驟見 `docs/DEPLOYMENT.md`。

大腦（例如 Muse）為一個目標派出的所有任務帶同一個 `missionId`（第一個任務再帶一個簡短的 `missionTitle`），分階段或分頭做的部分再帶 `missionPart`（子任務名，例如「盤點」「升級」）；交接和回覆會自動繼承。沒有 `missionId` 時，同一條交接／回覆鏈算同一個任務。分錯了或以前分散派出的任務，用 `psr_set_mission` 重新歸組（連同後續的回覆和交接一起搬，只改分組，不重送），或在總控臺任務面板的「整理」裡勾選其他任務併進來、把勾選的步驟設成一個子任務，或拆成獨立任務。

Demo 憑證和資料在 `.state/demo/`，五個入口各有獨立 token。不要把 token、資料庫或這個目錄上傳 Git。Demo 的遠端 Agent 是記憶體模擬器，真實程序重啟不會保存其模擬中的執行；Router 任務資料庫會保留。要重設 Demo，先停止程序，再明確刪除 **Demo 專用**資料目錄；不要對 live dataDir 做這件事。

## 2. 已實作的控制模型

```text
Grokbot / dot / Muse / Web / CLI
                  │
             HTTP + MCP
                  │
       一份 Core + SQLite + Outbox
                  │
          每個 daemon 一個 Adapter
                  │
       多機器 / 多帳號 / 多個 Session
```

身份分層為 Host → Daemon + incarnation → Managed Session；Worker 是長期角色別名，Workstream 是工作線，Task 是一次具體指令。Provider 的內部 session ID 只作 metadata，不能代替 Router 的發送主鍵。

精確 Session 優先；工作線有綁定就沿用；多個候選返回 ambiguous。沒有偷偷改派、最後活躍者猜測，或找不到就擅自新建。

| 能力 | 實作 |
|---|---|
| 多主機、多 daemon、背景 Agent 發現 | 完整分頁適配、命名空間隔離、狀態新鮮度 |
| 路由與去重 | 短期 client-bound ticket、CAS 綁定、精確固定目標、有限去重窗口 |
| 可靠派送 | 持久 queue、mutation-domain 單 writer、重啟對帳、`delivery_unknown` 不重發 |
| 排隊與來回 | 忙碌 session 不被打斷；FIFO 每則一個 turn；排隊位置、`queueTimeoutMs` 過期；`psr_wait_task`、`psr_reply_task` |
| Session 主動回報 | 模板建立的 session 自帶 Router MCP 與專屬憑證，turn 中途以 `psr_post_message` 回報進度／提問；派工的入口用 `psr_wait_messages` 收件 |
| 多入口 | 獨立 token、scope/project/host 限制、撤銷入口不取消已派工作 |
| 任務與結果 | 對應 turn 的終止證據；execution／verification／notification 分離 |
| Frontier | CAS、每 workspace 16 卡／每卡 4 KiB／3 個歷史槽／總共 32 KiB |
| Handoff | 具體父任務、依賴等待、深度／總量上限、產物可達性驗證 hook |
| 網頁總控臺 | 3D 總覽、機器視角、任務／子任務視角、關係視角共用同一份資料。「關係」把每台機器排成一欄、每個 session 一格，從任務畫出 session 之間的往來：派工、交接、呼叫服務、驗收、建立、傳檔，以及本機 session 之間的訊息（傳檔和訊息只有你看得到）；可以按 mission、時間範圍、往來種類篩選，點箭頭列出背後的任務，點格子打開那個 session。機器詳情列出這台的模板，按兩下就建 session；有人直接在 Paseo 裡用了某個 session 而暫停派工時，session 詳情會說明，並可按「恢復派工」。本機 session（psr-local）列在各台機器下：狀態、分支、收訊息方式（可改）、它的訊息和分支論壇（可貼文）；你可以用自己的名義發請求或通知，放行或拒絕停下等你的訊息（「機器」的「訊息」，也算進「需留意」），撤銷某台的機器憑證（發新憑證仍只在 Router 主機上做，憑證不經過網頁）。「機器」的「資源」管理共用資源：誰拿著、誰在排隊（附它們寫的用途），收回或移出排隊，改名額、提醒時間和說明，登記新的或移除；機器詳情和 session 詳情也會顯示相關的資源。「任務」的「檔案」列出一天內經 Router 送的檔案：誰送給誰、屬於哪個 mission、大小、sha256、等人收／正在收／已收／過期（口令永遠不顯示），mission 和 session 詳情也列出相關的檔案，「關係」畫成「傳檔」箭頭。有來源的 typed topology 仍由 `psr_get_topology` 提供 |
| 機器、session 樹、任務樹 | `psr_list_hosts` 給每台機器的 daemon、通道、session 在做什麼，以及 Router 所在機器的 CPU、負載和可用記憶體；`psr_get_tree` 在 Router 端算好兩棵樹：session 按誰建立的分組（規劃者與它建的 session、各入口、Router 座位、未記錄、Router 只是發現的），任務按 mission → 子任務 → 步驟，回覆／交接／重試／驗收掛在它接續的那一步下 |
| 更新 | SQLite 交易內 outbox、signed cursor、SSE、過期強制重同步 |
| 本機 session | 你手動開的 Claude Code／Codex 經 `psr-local` 橋接加入（每台機器一份憑證，不裝 hook）：同一個倉庫@分支的 session 共用一個論壇，能看到誰也在這個分支、在做什麼。需要別的 session 才能給的東西（主要是共用資源的先後：GPU、編輯器、鎖）時，可以點名發一則請求等它回覆；有上限，兩個 session 聊太多會先等你放行，消息只在回合之間送到，從不打斷。Claude Code 由橋接在回合之間送進 session（只有你標緊急的才在回合中）。Router 加了新工具，Claude Code 的 session 不用重開就能看到（橋接第 5 版起）；Codex 還要重開；跑在 Codex daemon 上的 Codex（`codex --remote unix://`）由橋接用 `codex queue` 送，同樣等這一輪結束、空閒時直接叫醒；其他 Codex 要另外裝 hook（`install.sh --hooks`，在 Codex 裡審核一次後生效），在回合結束、你發下一句話或 session 開始時送進去，沒裝就用收件箱拉 |
| 共用資源 | 你用 `psr_set_resource` 登記編輯器、GPU 這類同一時間只能一個（或幾個）session 用的東西（例如 `mac/unreal-editor`）。本機 session 用之前 `psr_local_take`，用完 `psr_local_release`；被佔用就排隊，輪到時 Router 在它兩輪之間通知它，不用輪詢。順序只看隊伍：持有者的備註、訊息、論壇貼文都不算預約，沒排隊的 session 查資源、發訊息問持有者或查空收件匣時，Router 會直接告訴它「你不在隊伍裡」。不能結束這一輪的 session（例如設了 `/goal`）用 `psr_local_wait` 在輪內等：一次最多掛 100 秒，資源輪到或有訊息就返回，沒有就再呼叫一次。想問佔用者（比如什麼時候用完），發給 `resource:<id>` 就行，不用知道是哪個 session。Router 派出的 Paseo session 也能拿（`psr_take`／`psr_release`，部署後新建的 http 通道 session 才有）；排隊輪到時，Router 以原來派活的那方名義給它接一輪，不打斷正在跑的那一輪；Paseo 持有者不收消息。session 結束或長時間沒聲音時自動歸還；有人在等、又佔用超過設定時間，Router 提醒一次。只是協調，不替代機器上的鎖 |
| 幫手 | 本機 session 自己不能建 session、不能派任務。要到別台機器或別的資料夾做事時，它用 `psr_local_helper_request` 請求一個幫手：選一個模板（決定機器、模型、權限模式），可以另外指定那台機器上的資料夾，寫清楚任務。你在總控臺「機器 › 幫手」看到誰提的、在哪台機器哪個資料夾、用什麼模型和模式、任務全文，批准之前什麼都不會開始；批准後 Router 建 session、以你的名義派任務，做完把結果送回提出的 session（兩輪之間，或它用 `psr_local_wait` 等）。接著問同一個幫手也要再批准一次。不想每次都批，可以在同一頁（或從「權限」頁的「幫手自動批准」進去）設「自動批准」規則：哪個模板、哪台機器提出的、請求可以自己指定哪些資料夾；符合的請求直接開始，卡片上會標出來。只有你能批的機器永遠不自動，每台機器一天最多自動啟動 30 個。只有你能批的機器只接受「每步都問人」的模板；`/`、頂層目錄、整個家目錄、agent 的設定目錄和席位的資料夾不能指定。每個 session 同時最多 2 個請求，24 小時沒決定就過期 |
| 檔案轉送 | 像 runpodctl：送的一方拿到一次性口令（`xfer-XXXX-XXXX-XXXX`），收的一方用口令取檔，機器之間不直連，由 Router 轉送。Paseo session 用 `psr_send_file`／`psr_receive_file`（Router 經 relay 讀寫它的工作目錄；1 MB 以內的文字檔原樣寫入，其他檔案以 base64 分塊寫入，並給合併和解碼的命令），本機 session 用 `psr_local_send_file`／`psr_local_receive_file`，人用 `psr-xfer send`／`receive`；資料夾打包成 `.tgz`。單檔 100 MB，最多等 60 分鐘，收件端確認收到後才作廢並刪檔；像機密的檔名或內容一律拒送。詳見 `docs/DEPLOYMENT.md` |
| Provider 登入 | 總控臺「機器」的「檢查登入」（`psr_check_logins`，只有你能用）經每台 Paseo 自己的 provider 診斷，讀 Claude、Codex 有沒有登入、登入方式、方案和到期時間；只留這幾欄，帳號、路徑不留，憑證不經過 Router。結果在 `psr_list_hosts` 每台機器的 `logins`，按現在的時間判斷：正常、7 天內到期、已過期、沒有登入、最近一輪登入失敗。Codex 的診斷不回報登入，只能看到「可用」。登入過期或 7 天內到期時，機器詳情會給一行 `psr-login <機器> claude|codex` 命令和複製按鈕，在你自己的終端機執行（Claude 貼回 code；Codex 用短碼，不用貼 callback 網址），登入不經過 Router。一輪的回覆只有 `Failed to authenticate…` 這類登入錯誤時，任務記為失敗，session 標「登入失效」，直到下一輪正常完成，或檢查發現登入恢復 |
| 機器狀態 | Router 在機器上沒有 shell，Paseo 也不回報機器資源，所以每台機器跑一個很小的回報程式（`integrations/status/psr-stat.py`，Python 標準庫，Linux 和 macOS）：每分鐘把 CPU 使用率、負載、記憶體、swap、每個磁碟的容量送給 Router，不送程序清單、檔名或內容，也不接受 Router 的指令。它用「狀態憑證」（`psrs_…`，`psr_issue_stat_credential`）：只能回報那台機器的數字，其他入口一律不認，所以只有你能批的機器也可以裝。總控臺的機器卡片有 CPU、記憶體、磁碟三條量表，機器面板有每個磁碟的明細；磁碟用到 85%／95%、可用記憶體剩 10%／5%、每核負載到 1.5／3 會標出來，地圖上的名牌也會顯示。`psr_list_hosts` 的 `machine` 欄位是同一份，規劃者派工時讀得到。數字只放在 Router 的記憶體裡，3 分鐘沒回報標成過期，一天後當作沒回報過。 |
| 交付接口 | 90 個工具、HTTP、MCP JSON HTTP、stdio bridge、CLI、OpenAPI |

## 3. CLI 和工具

在另一個 shell 設定 Router URL 和**你的 CLI 專用 token**。不要把 token 放到命令參數、URL 或 Agent prompt。

```bash
export PSR_URL=http://127.0.0.1:8787
read -s PSR_TOKEN
export PSR_TOKEN
npm run psr -- hosts
npm run psr -- sessions
npm run psr -- resolve '{"workerAlias":"eth-mm","workstreamId":"maker-fill-validation"}'
npm run psr -- submit SESSION_REF '請繼續目前的驗證工作' --key user-intent-001
npm run psr -- task TASK_ID
```

`SESSION_REF` 和 `TASK_ID` 換成查詢得到的值。不同入口可以查同一 task，但不能交換 client-bound 路由票據。重試原意圖沿用原去重 key；獨立意圖用新 key。

主要 HTTP endpoint：

```text
GET  /v1/hosts
GET  /v1/sessions
POST /v1/resolve-target
POST /v1/tasks
GET  /v1/tasks/{taskId}
POST /v1/tasks/{taskId}/cancel
GET  /v1/topology
GET  /v1/events?after={signedCursor}
GET  /openapi.json
POST /v1/tools/{toolName}
POST /mcp
```

除了健康檢查和 Web 靜態資產，均需 `Authorization: Bearer ...`。`docs/tool-catalog.json` 是完整契約；不要依名稱猜測輸入欄位。

## 4. 接真實 Paseo

真實 SDK 是可選依賴，用 `npm run install:paseo` 安裝固定的版本。

在可連線的部署機器：

```bash
npm run install:paseo
cp config/router.example.json router.local.json
node scripts/generate-secrets.mjs .env
```

編輯 `router.local.json`：host／daemon 身份、工作目錄、worker、**真正共享檔案的 mutationDomainId**，以及每個 daemon 的連線方式（下方二選一）。使用配置好的獨立低權限 OS 帳號。範例的 `releasePolicy` 是 `on_turn_end`：turn 結束且 Router 確認 session 已空閒後自動釋放 writer 鎖，同一 mutation domain 的下一個任務才會派送。`manual` 下每個完成的任務都要管理員執行 `psr_release_mutation`；Grokbot／dot／Muse 沒有 admin scope，所以會停在第一個任務之後。只有當 turn 結束後仍可能有背景 writer（例如背景 shell job）繼續寫檔時才用 `manual`。

`@getpaseo/client` installer 固定頂層版本 `0.15.2`，和 daemon 一致（2026-11-08 在 Paseo 0.15.2 上實測：列表、建 session、turn、歷史、權限拒絕、取消、讀寫檔案；之前是 0.12.0）。升級 SDK 前先在測試 Router 或腳本裡對一台非實盤 daemon 跑同樣的驗收。可用 `sdkModule` 明確指向另一個**已驗證版本**的模組，不要靜默使用 latest。

### 加一台機器（推薦：Paseo 中繼，不需要 SSH）

在那台機器上（已安裝並運行 Paseo）：

```bash
paseo pair
```

把印出的配對鏈接存進 Controller 的 `.env`，例如 `PASEO_GPU1_PAIRING=https://app.paseo.sh/#offer=…`，daemon 設 `"pairingEnv": "PASEO_GPU1_PAIRING"`（不設 `url`）。Router 經 Paseo 中繼以端到端加密連線（與 Paseo 手機 app 相同），伺服器不必開端口，也可在 NAT／防火牆後。身份由 E2EE 握手證明：只有持有該 daemon 私鑰者能完成連線，因此不需要 identity probe。

**配對鏈接等同該 daemon 的 owner 權限**：目前的 Paseo 會讓持有鏈接的中繼客戶端以 owner 身份進入（即使設了密碼）。只放在 `.env`／密鑰管理，不要寫進設定檔或提交 Git；外洩時需在 Paseo 側更換 daemon 金鑰使舊鏈接失效。

daemon 再加 `"agentChannel": {"mode": "observed"}`，從模板建立的 session 會帶一個本機執行的 `psr_post_message` 工具（用該機器上的 Node 執行，`nodeCommand` 可指定路徑）。Session 在 turn 中途呼叫它，Router 從已經在觀察的 Paseo 時間線讀到這次呼叫並轉給派工者：agent 不需要連回 Controller，也不帶任何憑證。

### 或：直連／SSH 隧道

Controller 能直接到達 daemon 時用 `url`。遠端可先在 Controller 建立隧道，例如：

```bash
ssh -NT \
  -L 127.0.0.1:17671:127.0.0.1:6767 \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  gpu1
```

遠端 Paseo daemon 必須已運行，SDK URL 為 `ws://127.0.0.1:17671/ws`。第二個 daemon 用另一個轉發端口。不要把裸 Paseo 管理端口暴露到公網。

範例 identity probe 讀取管理員在遠端建立的固定身份檔。它是 **SSH host-key + 管理員身份登記**的檢查，不是 Paseo 協議提供的加密 attestation。重新初始化 daemon 或資料目錄後，必須更新身份檔及 incarnation；不要沿用舊世代 ID。更多見 `docs/DEPLOYMENT.md`。SSH probe 每次都是一次完整登入：目錄同步預設沿用 60 秒內的結果（`identityProbe.cacheMs`），派工前一律重新檢查。

沒有逐一登記 cwd 的 daemon 可加 `autoMap`（`projectId`、`releasePolicy`）：發現的 session 依「主機 + cwd」自動得到 mutation domain，可直接派工；明確 mapping 仍優先。`externalTurns` 決定有人直接在 Paseo 使用 session 時的處理：`pause`（明確 mapping 預設）暫停到明確恢復，`wait`（autoMap 預設）只等那一輪結束。

```bash
# 載入你剛剛產生並保管的憑證
set -a
. ./.env
set +a

# 只讀：不派工、不建立 Session、不取消工作
npm run smoke:live -- router.local.json

# 僅在確認配置和只讀結果後啟動常駐服務
npm start -- --config router.local.json
```

Router 預設只監聽 `127.0.0.1`；要監聽其他位址，設定檔必須寫 `"listenBeyondLoopback": true`，啟動時也會警告。用 tailnet（例如 `tailscale serve --bg 8787`）、VPN 或有驗證的 TLS 反向代理連進來，**絕不要直接暴露在公網**。

**這個 smoke 只驗證連線／身份／list／refresh。** 真實寫入必須在測試 checkout，經操作者明確提交一個無害任務，再檢查 turn 關聯及結果；不能把只讀 smoke 當作完整驗收。

### 安全

Router 握有每台已連 Paseo daemon 的 owner 權限：**誰控制了 Router，誰就能在你所有機器上跑程式**。資料目錄裡的 SQLite 存著 Router 的簽章密鑰，和 `.env` 一樣要保管好。部署前先讀 [SECURITY.md](SECURITY.md)：威脅模型、內建防護、部署清單和已知限制；發現漏洞請照裡面的方式私下回報。

## 5. 三個聊天入口

- Grokbot：可以供支援相應認證的客戶端使用 Remote MCP，或在已授權機器使用 stdio bridge。
- dot：使用帳號實際授權的 plugin/tool 路徑；需要寫工具權限。若只能 OAuth，需另外部署經檢查的 OAuth gateway；本包不提供 OAuth 授權伺服器。
- Muse：提供 HTTPS API、OpenAPI 和工具契約，按實際 connector 能力接入；不假定所有名為 Muse 的產品都接受同一協議。
- 只有終端、沒有 MCP 的雲端電腦（例如 Meta 的 Muse 雲端電腦）：加入 Router 所在的 tailnet 後執行 `curl -fsSL https://<router>/integrations/cloud-shell/install.sh -o psr-install.sh && PSR_URL=https://<router> sh psr-install.sh`（Router 的網址會存在憑證旁邊，之後不用再設）。它安裝只用 curl 的 `psr` 指令與 `~/.config/psr/AGENT.md` 操作說明，憑證以隱藏輸入存成 0600 header 檔，只經 HTTPS 送往 Router。

各入口的**帳號連線驗收都仍是 `not_tested`**。測試中的 Grokbot/dot/Muse 指使用這三個 client ID 的真正 HTTP 請求，不是三家服務端的測試。

MCP 本版是無狀態、tools-only、協議 `2025-06-18` 的 JSON HTTP 實作（唯一的例外：agent 用自己的 session 憑證呼叫 `psr_ask` 時，回應改成 `text/event-stream`，先串流進度、最後送出結果），支援 initialize、ping、tools/list、tools/call 及相關 lifecycle notifications。GET `/mcp` 回 405；不廣告 sampling/resources/push；沒有自行假冒完整官方 SDK 相容認證。詳細流程在 `docs/INTEGRATIONS.md`。

## 6. 保守的執行行為

`queued` 只是保存任務，`accepted` 只是 daemon 接受 prompt。`idle`、timeout 或文字「完成了」都不構成任務完成證據。

一旦 send 後斷線，可能有送達：保存 `delivery_unknown`，鎖不釋放、不重發。對帳依據為原始 user message 的唯一標記及明確 turn ID。若 SDK/provider 沒有提供可靠關聯或遺失的歷史中沒有 terminal event，保持未決，交由人檢查。

取消：排隊中的任務直接在 Router 撤回；執行中或等審批的那一輪，真實 Paseo adapter 用 Paseo 的 `cancel_agent_request`（只中斷當前這一輪，session 保留）停下，Router 收到 `turn_canceled` 才記為已取消。永遠不拿 archive/kill 代替取消。等審批超過「權限」裡設的時間（預設 2 小時）的那一輪會被自動取消，請求一併消失。還沒送出的任務可以用 `psr_move_task` 改派到別的 session。一輪的唯一回覆是暫時性的 provider 錯誤（過載、5xx、逾時、token 刷新衝突）時，Router 以新任務自動重試一次（`retryOf`）；只回額度用完的 session 會標出 `providerLimit`，派給它時回傳 `warning`，下一輪正常完成後解除。

`manual` writer release 下，即使 turn completed，仍需管理員核對背景 jobs 已結束，再使用 `psr_release_mutation`。`psr_attest_outcome` 是帶證據的人工對帳，記錄會明確標成 operator attestation，而非 native event。

**Session 正忙時：** Router 從不插入或打斷正在跑的 turn（Paseo 的 steer 在 provider 不支援時會改成替換當前 turn，因此不使用）。新消息成為獨立任務，按提交順序（同一 mutation domain 內 FIFO）每則一個 turn 送出，不合併。發送方立即拿到 task ID，不必阻塞；`psr_get_task` 顯示排隊位置與阻擋原因，`psr_wait_task` 最多等 55 秒，逾時再等即可。`queueTimeoutMs` 讓過時的消息在送出前自動取消；`psr_cancel_task` 可撤回仍在排隊的消息。`psr_reply_task` 對同一 session 追問，排在被回覆的任務之後，`includeSourceResult` 會在送出時附上它的結果（`psr_handoff` 同樣支援）。

**Session 主動找總控制：** daemon 設定 `agentChannel` 後，`psr_create_session` 建立的 agent 會帶一個名為 `psr` 的 MCP，`psr_post_message` 已預先批准。預設 `observed` 模式：工具在 agent 所在機器本地執行、只回覆「已記錄」，呼叫本身寫進 Paseo 時間線，Router 經既有的 daemon 連線讀到後轉交，agent 不需要任何連回 Controller 的路徑或憑證。`http` 模式（設 `url`）則讓 agent 直接呼叫 Router `/mcp`，憑證放在 header、只能以該 session 身份留言、呼叫服務（`psr_ask`，見上文「服務呼叫」）和讀寫它所在任務的論壇（`psr_forum_read`、`psr_forum_post`，見上文），`psr_revoke_agent_channel` 可撤銷。留言是非同步的：立即返回，回答以下一個 turn 送達，所以 agent 若需要答案才能繼續，提問後就應結束這一輪。派工者用 `psr_wait_messages`（或 `psr_wait_task` 加 `afterMessage`）收件，以 `psr_reply_task` 回覆。Paseo 只在建立 agent 時接受 MCP 設定，直接在 Paseo app 建立的 session 沒有這個通道。

**權限審批與等級：** session 的權限模式要求審批時，任務是 `waiting_permission`。Router 按確切的命令或檔案路徑給每個請求定級：L0 只讀、L1 只改這個 session 自己目錄裡的檔案、L2 安裝和執行、L3 服務和系統（含 sudo、改工作目錄以外的檔案）、L4 交易和機密（下單、憑證、金鑰，以及**任何認不出來的動作**）。一串命令按最危險的一步算；`cd` 之後的路徑按真正指向的位置判斷；你加的規則優先於內建規則，但憑證和金鑰永遠是 L4，除非你明確關掉那條內建規則。每一級由誰批准在「權限」裡設定：你（管理員）永遠可以；預設 L0–L2 由規劃者批，L3 只有你，L4 永遠只有你；也可以開放給前臺（只限它自己派的任務）。`psr_list_permissions` 和總控臺都會顯示等級、命中的規則和誰能批；在請求上點「以後這條命令算…」可以直接記成一條規則。主機設了 `humanApproval: true` 時只接受你的回答。規劃者不能批准自己 session 的請求。每次回答只對一個請求生效一次，不會放寬 session 的權限模式；誰在何時以什麼等級批准了什麼，記在任務的 `approvals` 裡。

**自動批准（預設關閉）：** 不想每個請求都自己批，可以在「權限」頁的「自動批准」讓 Router 代答（或 `psr_set_policy {autoApprove: {all, trusted, sources, secrets, hours}}`）。session 照常提出請求，Router 每一輪把符合設定的直接批准並記在任務上（`by: router`、`rule: auto:…`），其餘照舊等人；它只會批准，不會拒絕。兩段：**一般指令**（所有任務，最高到 L2）和**危險指令**（L3 或 L4，只限來自可信來源的任務）。可信來源是派任務的客戶端（總控臺、CLI、某個前臺）或「某台機器的本機 session 請求的幫手」。幫手任務算提出請求的那台機器，不算批准它開始的人；規劃者派的任務、Router 代寫的輪（服務的回覆、資源輪到你的通知）不算任何人的指令，只適用一般指令那一段；暫時性失敗後重送的任務算原本那個。L4 預設不含憑證和金鑰，要另外勾。可以設有效期，到期自動關閉；關閉會清掉可信來源和有效期，而且立刻生效。不管怎麼設都不自動的：只有你能批的機器、Router 自己的輪（驗收、服務呼叫）、規劃者自己的 session、不是這個任務這一輪提出的請求、內容被截斷的請求，以及一個任務裡第 30 條之後的危險指令。生效期間總控臺頁首會一直顯示標記，待批的請求上會寫為什麼沒有自動。這等於信任每個能以可信來源名義說話的 agent session（那台機器上任何拿著機器憑證的本機 session、拿著前臺 token 的人），而且判斷只看命令列、不看腳本內容，所以危險那一段只開給需要的來源和時間。

**只讓你批的機器：** 標了 `humanApproval` 的機器，權限請求只有你能批；但 session 若跑在不會來問你的 mode（Claude `auto`、`acceptEdits`、`bypassPermissions`，Codex `auto-review`、`full-access`，或 Router 不認得的 mode），根本不會發請求。所以在這種機器上，只有你能派任務給這類 session；Grokbot、Muse、規劃者都只能派給請求會到你手上的 session（Claude `default`／`plan`，Codex `auto`／`read-only`），否則回 `OWNER_ONLY_TARGET`。派送時和送出前會再查一次：排隊期間被改成這類 mode 的任務會停在佇列裡，mode 改回來才送。

**前臺權限上限：** 每個前臺的權限 = 你在「權限」裡設的上限，再被規劃者在上限內收緊（`psr_set_access`）；規劃者不能放寬到上限以外，前臺也改不了自己的權限。建議的上限是「下目標、批准方案、看進度」（`goal`、`plan`、`read`）。沒設上限的前臺沿用設定檔裡的 scopes。

`completed` 是 Paseo 的生命週期證據，不代表工作成功，必須閱讀結果。整個回覆只有一句 provider 額度通知（例如 Claude Code 的 "You've hit your weekly limit"）時，Router 把任務標成 `failed`，結果欄保留那句通知；其他 provider 錯誤仍可能以普通回覆結束 turn。

鎖只約束 Router 派工；直接 Paseo App/CLI 可以繞過它。Router 發現外部 turn 會暫停後續派工，但沒有 daemon 級原子條件提交，因此不是全域檔案鎖。並行修改最好使用隔離 checkout/worktree。

## 7. Frontier 和產物

預設 Router SQLite 是新 workspace Frontier 的唯一主本。已有 worklog 主本時，應配置 `frontierCommand`，Router 不再另存一份獨立可寫主本。

附帶的 `scripts/frontier-file-bridge.py` 是可選的**獨立 JSON Frontier 主本**，有原子替換及跨程序 CAS；它**不是**既有 `worklog 0.2` 的直接適配器。不要把它指向你的既有 worklog 目錄。既有 worklog 的精確 read/resume/handoff/finish 轉接仍需依該工具版本實作。

Worker 不會自動獲得全局 API token；Frontier 的語義更新由授權入口明確提交。本版沒有自動從聊天推導進展、沒有自動同步每台主機上的 worklog、沒有 worker task-scoped callbacks。

Handoff 不複製 provider 私有上下文，也不搬檔案。沒有 `artifactVerifier` 時帶產物的 handoff 會明確拒絕；純有界文字工作包可用。不要把模型自述的「可訪問」當作驗證。

## 8. 測試與開發

已編譯測試可直接執行；外部 Frontier bridge 測試另需 Python 3（POSIX）。

```bash
npm test
# 改 TypeScript 原始碼時：
npm run install:dev
npm run build
npm test

# 瀏覽器介面測試（另安裝 Python Playwright + Chromium）：
python -m pip install playwright
python -m playwright install chromium
npm run test:ui   # 或：uv run --no-project --with playwright python scripts/test_ui.py
```

若機器已有 Chromium，可設 `CHROMIUM_PATH=/path/to/chromium`。本次受管瀏覽器禁止 URL 導航，因此 UI 測試用 `PSR_UI_OFFLINE_BROWSER=1` 的記憶體頁面＋真實本地 HTTP API bridge，不更改瀏覽器策略；真正 SSE 網絡流程另外在 HTTP 測試覆蓋。這個差別記錄在 `reports/ui-tests.json`。

測試輸出寫在 `reports/`（不進 repo）。測試不使用真實模型、交易程序、使用者 SSH 私鑰或第三方帳號。

## 9. 程式結構

```text
src/core.ts                路由、綁定、派送、對帳、Frontier、topology
src/store.ts               SQLite、原子 outbox、鎖、去重與保留策略
src/paseo-adapter.ts        Paseo SDK 邊界（已在 Paseo 0.15.2 實機驗證）
src/demo-adapter.ts         明確隔離的模擬遠端
src/server.ts              HTTP／SSE／MCP 入口，共用 Core
src/tools.ts               90 個工具與 OpenAPI 契約
src/policy.ts              權限等級：內建規則、判級（命令拆分、路徑、憑證）、規則檢查
src/auto-approve.ts        自動批准：設定、檢查、單一請求的判斷（按等級和任務來源）
src/machine-status.ts      機器狀態：回報的格式和逐欄檢查、門檻、狀態憑證的型別
src/planner.ts             規劃者：指令、可用工具、關掉的內建工具、喚醒摘要
src/cli.ts                 CLI
src/mcp-stdio.ts            MCP stdio → HTTP bridge
src/local.ts               本機 session：機器憑證、加入／離開、倉庫@分支論壇
src/peer.ts                session 之間的消息：請求／回覆／通知、上限、留給 owner、回合之間送達
src/resources.ts           共用資源（編輯器、GPU）：你登記，session 用前拿、用完還，排隊輪到時通知；消息可發給資源的佔用者
integrations/local/        psr-local 橋接（本機 Claude Code／Codex 的 stdio MCP）、Codex hook（psr-hook.mjs）與安裝腳本
integrations/status/       機器狀態回報程式（psr-stat.py）與安裝腳本
src/guard.ts                程序級單活躍 Controller 鎖
web/                       總控臺：app.js（登入、資料、事件流）、park.js（3D 總覽與右側面板）、views.js（機器、任務、權限視角）
web/vendor/three-0.186.1/  隨包附帶的 three.js（MIT），CSP 只允許同源腳本，不連 CDN
scripts/                   建置、配置、Frontier bridge、瀏覽器測試
skills/                    三入口的共用操作規則與平台注意事項
deploy/                    systemd、SSH tunnel、TLS proxy、Docker 範例
tests/                     核心、HTTP、協議、結構、崩潰、CAS、容量測試
```

相對 v0.2 設計的明確調整：前端採原生 JS 加隨包附帶的 three.js（總控臺 3D 總覽，登入後才載入），而非 React Flow；MCP 採已測試的最小 tools-only 協議層，而非未安裝的官方 SDK；目錄用有限輪詢，任務 timeline 用訂閱及補讀；本版單使用者、單 Controller，無多租戶／HA。完整缺口和下一個驗收關卡見 `docs/STATUS.md`。
