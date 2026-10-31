# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio는 소스 편집, 펌웨어 빌드와 업로드, 시리얼 통신, 하드웨어 디버깅, Git, 팀 협업을 통합한 모듈형 임베디드 개발 환경입니다. Electron 데스크톱 앱을 사용하거나, 프로젝트와 장치가 있는 컴퓨터에서 Node.js 호스트를 실행하고 브라우저로 접속할 수 있습니다.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## 제공 기능

- clangd 기반 C/C++ 자동 완성, 정의와 참조, 진단, 서식 지정. 대체 작업 영역 인덱스, 미리 보기 탭, 분할 편집, 초안 복구를 지원합니다.
- 장치를 연결하지 않고 빌드할 수 있습니다. 이름 있는 빌드 진입점, Debug/Release, 크기 최적화, C/C++별 도구 선택을 제공합니다.
- BIN, HEX, S-record, ELF 내보내기, 준비된 펌웨어 업로드, 외부 소스 의존성을 포함한 프로젝트 공유.
- Arduino 라이브러리 검색, 구성 요소 폴더 또는 ZIP 가져오기, 장치 모듈과 도구 모음의 오프라인 내보내기.
- 레지스터, 디스어셈블리, 호출 스택, 메모리 확인. 연결된 대상의 단계 실행과 중단점 일괄 추가.
- 탭, 편집 범위, 최신 로그 공유. 독립적인 변경을 병합하고 충돌은 보존합니다. 브라우저의 실행 취소는 자신의 변경에만 적용됩니다.
- Git 기록, 차이, 스테이징, 커밋, 브랜치, 원격 저장소의 그래픽 관리. 여러 네이티브 터미널과 VS Code 연결.
- 이미지 미리 보기와 오디오·비디오 재생. 선택적으로 켜는 AI 자동 완성과 지정 범위의 질문·수정. 모듈과 확장은 자체 리소스와 언어 목록을 관리합니다.

## 배포판 선택

| 배포판          | 실행 환경                         | 파일                                        |
| --------------- | --------------------------------- | ------------------------------------------- |
| 데스크톱 포터블 | Windows x64, 바로 실행            | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| 독립형 Web      | Windows x64, Node.js 포함         | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Node.js용 Web   | Windows x64, Node.js 24+ x64 필요 | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

세 배포판은 프로젝트 형식과 호스트 서비스를 공유합니다. Node.js ZIP의 압축을 풀고 `start-web.cmd`를 실행하세요. 의존성이 포함되어 있습니다. `main` 소스가 배포 파일보다 최신일 수 있으므로 다운로드 기능은 릴리스 노트를 확인하세요.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## 하드웨어와 호스트 지원

| 장치 모듈                        | 빌드 도구                        | 연결                |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

현재 프로필은 ESP32-S3와 STM32F103C8/C8T6을 지원합니다. 카메라 핀은 프로젝트에서 설정합니다. ESP32-S3 UART GDB는 Windows 기준 구성에서 검증했으며 네이티브 USB-JTAG 검증은 계속 진행 중입니다. Windows x64가 주요 배포 환경입니다. Linux x64/ARM64 대응과 macOS 사용자 도구 경로는 실제 장비 검증을 완료하지 않았습니다.

## 빠른 시작

소스 개발에는 Node.js 24+, npm, Git이 필요합니다.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

브라우저 환경을 쓰려면 프로젝트와 장치가 있는 컴퓨터에서 다음 명령을 실행하고 출력된 링크를 여세요. 폴더 선택, 빌드, USB, 시리얼 포트와 터미널은 해당 호스트 컴퓨터에서 처리됩니다.

```sh
npm run web:build
npm run web:start
```

## 모듈 구조와 바이너리 호스트

장치 모듈은 `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages`, `tools`의 열 가지 책임으로 나뉩니다. `be`는 빌드 입력을, `blode.components.json`은 프로젝트 라이브러리를 기록합니다. `package:runtime`은 독립적인 JavaScript, 매니페스트와 리소스를 생성합니다. 호환되는 데스크톱 바이너리와 Web 호스트는 호스트 TypeScript 소스 없이 이 패키지를 로드합니다. 일반 확장은 컴파일러 없이도 외관, 메뉴, 창과 하단 패널을 추가할 수 있습니다.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## 패키지 서명

- `obe`는 Ed25519로 서명한 JSON 매니페스트입니다. 게시자, 패키지 ID/버전, 각 파일의 경로·크기·SHA-256을 묶으며 설치 전 실제 내용을 다시 확인합니다.
- 공식 신뢰 정보는 호스트의 공개 키 목록에서 가져옵니다. 서명 없음 또는 알 수 없는 게시자, 손상된 서명, 내용 변경을 구분합니다. 내보내기는 원래 서명을 보존하며 외부 패키지에 공식 신분을 부여하지 않습니다.
- 관리자의 개인 키는 `.signing/`에 보관하며 Git과 배포 파일에서 제외합니다. Windows Authenticode는 별도 계층이며 현재 인증서는 공인 CA가 발급한 것이 아닌 자체 서명 인증서입니다. 서명한 내용을 변경하면 다시 서명해야 합니다.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [모듈 구조와 바이너리 호스트](ENGINEERING.md)

## 진행 중인 작업

- 추가 하드웨어 검증, 장시간 협업, 컴퓨터 간 프로젝트 이전.
- AI 제안 품질, 입력기 동작, 언어별 전문 용어 검토.
- Linux/macOS 실제 장비에서 설치, 도구 모음과 USB 검증.

## 문서

- [모듈 구조와 바이너리 호스트](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [패키지 서명](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## 라이선스와 기여

소스는 Apache License 2.0으로 공개됩니다. 외부 컴파일러, 드라이버와 서비스는 각각의 조건을 따릅니다. 문제 보고와 개선 제안은 GitHub Issues와 Pull Requests를 이용하세요.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
