# Blode Studio

[简体中文](../README.md) · **繁體中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio 是模組化嵌入式開發工作台，整合程式碼編輯、韌體建置與燒錄、串列通訊、硬體偵錯、Git 與團隊協作。可使用 Electron 桌面應用程式，或在持有專案與硬體的電腦執行 Node.js 主機，透過瀏覽器存取。

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## 已完成的功能

- 透過 clangd 提供 C/C++ 補全、定義、參考、診斷與格式化，並以工作區索引作為後備；支援預覽分頁、分割編輯與草稿還原。
- 無須連接裝置即可建置；支援具名建置入口、Debug／Release、體積最佳化與 C／C++ 個別工具鏈設定。
- 匯出 BIN、HEX、S-record 與 ELF，燒錄預先準備的韌體，並分享包含外部原始碼相依項目的專案。
- 搜尋 Arduino 程式庫，匯入元件資料夾或 ZIP，並匯出裝置模組與工具鏈供離線使用。
- 查看暫存器、反組譯、呼叫堆疊與記憶體，對已連接的目標進行單步執行及批次中斷點操作。
- 同步分頁、編輯範圍與最新記錄；合併互不衝突的變更並保留衝突。瀏覽器的復原僅處理目前使用者的變更。
- 圖形化管理 Git 歷程、差異、暫存、提交、分支與遠端；支援多個原生終端工作階段及 VS Code 連接。
- 圖片預覽與影音播放；可選擇啟用 AI 補全及限定範圍的問答與修改。裝置模組和通用擴充功能各自管理資源與語言清單。

## 選擇發行版本

| 版本           | 執行環境                        | 檔案                                        |
| -------------- | ------------------------------- | ------------------------------------------- |
| 桌面可攜版     | Windows x64，直接執行           | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| 獨立 Web 版    | Windows x64，內含 Node.js       | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web Node.js 版 | Windows x64，需 Node.js 24+ x64 | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

三種版本共用專案格式與主機服務。解壓縮 Node.js ZIP 後執行 `start-web.cmd`，套件已包含相依項目。`main` 原始碼可能領先發行套件；下載版本的功能以發行說明為準。

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## 支援的硬體與主機

| 裝置模組                         | 建置工具                         | 硬體連接            |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

目前的裝置設定支援 ESP32-S3 與 STM32F103C8/C8T6。攝影機接腳由專案設定。ESP32-S3 UART GDB 已在 Windows 參考環境完成驗證，原生 USB-JTAG 持續驗收。Windows x64 是主要發行環境；Linux x64/ARM64 適配與 macOS 自訂工具路徑尚未完成實機驗證。

## 快速開始

從原始碼開發需要 Node.js 24+、npm 與 Git。

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

使用瀏覽器工作台時，請在專案與硬體所在的電腦執行下列命令，開啟服務輸出的連結。資料夾選擇、建置、USB、串列埠及終端均由該主機電腦處理。

```sh
npm run web:build
npm run web:start
```

## 模組結構與二進位主機

裝置模組分為十項職責：`support`、`device`、`runtime`、`constraints`、`ui`、`compiler`、`debugger`、`layout`、`languages`、`tools`。`be` 保存建置輸入，`blode.components.json` 記錄專案程式庫。`package:runtime` 產生獨立 JavaScript、宣告與資源；相容的桌面二進位程式和 Web 主機無須取得主機 TypeScript 原始碼即可載入。通用擴充功能可提供外觀、選單、視窗與底部面板，不必實作編譯器。

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## 套件簽章

- `obe` 是以 Ed25519 簽署的 JSON 清單，綁定發行者、套件 ID／版本，以及每個檔案的路徑、大小和 SHA-256。安裝寫入前會重新檢查實際內容。
- 官方信任來源是主機內建的公開金鑰清單。系統區分未簽署或未知發行者、簽章損壞及檔案內容變更。匯出保留原簽章，不會把第三方套件變成官方套件。
- 維護者私密金鑰保存在 `.signing/`，不納入 Git 或發行套件。Windows Authenticode 是獨立的簽章層，目前憑證為自簽憑證，並非公開 CA 憑證。修改已簽署內容後需要重新簽署。

[OBE / Authenticode](PACKAGE-SIGNING.md) · [模組結構與二進位主機](ENGINEERING.md)

## 正在進行

- 擴充硬體驗收、長時間協作與跨電腦專案遷移。
- 改善 AI 建議品質、輸入法體驗及多語言術語校對。
- 驗證 Linux／macOS 實機安裝、工具鏈與 USB 操作。

## 文件

- [模組結構與二進位主機](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [套件簽章](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## 授權與貢獻

原始碼採用 Apache License 2.0。第三方編譯器、驅動程式與服務依各自條款提供。歡迎透過 GitHub Issues 和 Pull Requests 回報問題及提交改進。

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
